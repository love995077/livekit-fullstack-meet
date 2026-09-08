import asyncio
import os
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from livekit import api

# Load .env from the repo root as well as from the server directory, so the app
# works both when run locally (`uvicorn main:app` inside ./server) and when the
# platform injects the values as real environment variables.
load_dotenv()
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))

LIVEKIT_URL = os.getenv("LIVEKIT_URL")
LIVEKIT_API_KEY = os.getenv("LIVEKIT_API_KEY")
LIVEKIT_API_SECRET = os.getenv("LIVEKIT_API_SECRET")

app = FastAPI(title="LiveKit Meet Token & Signaling Server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------------- #
# In-memory signaling state
# --------------------------------------------------------------------------- #


class Participant:
    """One live WebSocket in a room."""

    def __init__(self, websocket: WebSocket, name: str, role: str) -> None:
        self.websocket = websocket
        self.name = name
        self.role = role  # "host" | "guest"

    async def send(self, payload: Dict[str, Any]) -> bool:
        """Send JSON, reporting whether the socket is still usable."""
        try:
            await self.websocket.send_json(payload)
            return True
        except Exception:
            return False


class Room:
    """Signaling state for a single meeting room."""

    def __init__(self) -> None:
        self.participants: List[Participant] = []
        # Knocks that arrived before any host was connected, replayed on host join.
        self.pending_knocks: List[str] = []
        # Latest whiteboard records, replayed to clients that join late.
        self.whiteboard: List[Dict[str, Any]] = []
        self.lock = asyncio.Lock()

    @property
    def hosts(self) -> List[Participant]:
        return [p for p in self.participants if p.role == "host"]

    def guests_named(self, name: str) -> List[Participant]:
        return [p for p in self.participants if p.role == "guest" and p.name == name]

    def others(self, me: Participant) -> List[Participant]:
        return [p for p in self.participants if p is not me]

    def is_empty(self) -> bool:
        return not self.participants


rooms: Dict[str, Room] = {}


async def fan_out(targets: List[Participant], payload: Dict[str, Any], room: Room) -> None:
    """Send to many participants, dropping any whose socket has died."""
    if not targets:
        return
    results = await asyncio.gather(*(p.send(payload) for p in targets))
    dead = [p for p, ok in zip(targets, results) if not ok]
    for p in dead:
        if p in room.participants:
            room.participants.remove(p)


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #


@app.get("/")
def health():
    return {
        "status": "ok",
        "livekit_url": LIVEKIT_URL,
        "active_rooms": len(rooms),
    }


@app.get("/getToken")
def get_token(room_name: str, participant_name: str):
    if not LIVEKIT_API_KEY or not LIVEKIT_API_SECRET:
        raise HTTPException(status_code=500, detail="LiveKit credentials are not configured")

    token = (
        api.AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
        .with_identity(participant_name)
        .with_name(participant_name)
        .with_grants(api.VideoGrants(room_join=True, room=room_name))
        .to_jwt()
    )

    return {"token": token, "url": LIVEKIT_URL, "room": room_name, "identity": participant_name}


# --------------------------------------------------------------------------- #
# WebSocket: waiting room + whiteboard sync
# --------------------------------------------------------------------------- #


@app.websocket("/ws/meeting/{room_name}")
async def meeting_socket(
    websocket: WebSocket,
    room_name: str,
    name: str = "Guest",
    role: str = "guest",
):
    await websocket.accept()

    role = "host" if role == "host" else "guest"
    room = rooms.setdefault(room_name, Room())
    me = Participant(websocket, name, role)

    async with room.lock:
        room.participants.append(me)
        replay_knocks = list(room.pending_knocks) if role == "host" else []
        if role == "host":
            room.pending_knocks.clear()
        whiteboard_snapshot = list(room.whiteboard)
        hosts_online = len(room.hosts) > 0

    await me.send(
        {
            "type": "connected",
            "room": room_name,
            "role": role,
            "name": name,
            "hosts_online": hosts_online,
        }
    )

    # Bring a late-joining client up to date with the current drawing.
    if whiteboard_snapshot:
        await me.send({"type": "whiteboard_update", "data": whiteboard_snapshot, "snapshot": True})

    # A host arriving after guests knocked still sees those requests.
    for pending_name in replay_knocks:
        await me.send({"type": "knock", "name": pending_name})

    try:
        while True:
            message = await websocket.receive_json()
            if not isinstance(message, dict):
                continue

            kind = message.get("type")

            if kind == "knock":
                knocker = str(message.get("name") or me.name)
                me.name = knocker
                async with room.lock:
                    hosts = room.hosts
                    if not hosts:
                        if knocker not in room.pending_knocks:
                            room.pending_knocks.append(knocker)
                if hosts:
                    await fan_out(hosts, {"type": "knock", "name": knocker}, room)
                else:
                    await me.send({"type": "waiting", "reason": "host_absent"})

            elif kind == "decision":
                if me.role != "host":
                    continue  # only the host decides who gets in
                guest_name = str(message.get("name") or "")
                approved = bool(message.get("approved"))
                async with room.lock:
                    targets = room.guests_named(guest_name)
                    if guest_name in room.pending_knocks:
                        room.pending_knocks.remove(guest_name)
                await fan_out(
                    targets,
                    {"type": "decision", "name": guest_name, "approved": approved},
                    room,
                )

            elif kind == "whiteboard_update":
                data = message.get("data")
                async with room.lock:
                    if message.get("snapshot") and isinstance(data, list):
                        room.whiteboard = data
                    targets = room.others(me)
                await fan_out(targets, {"type": "whiteboard_update", "data": data}, room)

            elif kind == "whiteboard_clear":
                async with room.lock:
                    room.whiteboard = []
                    targets = room.others(me)
                await fan_out(targets, {"type": "whiteboard_clear"}, room)

            elif kind == "ping":
                await me.send({"type": "pong"})

    except WebSocketDisconnect:
        pass
    except Exception:
        # A malformed frame should only take down this one connection.
        pass
    finally:
        async with room.lock:
            if me in room.participants:
                room.participants.remove(me)
            left_empty = room.is_empty()
        if left_empty:
            rooms.pop(room_name, None)
