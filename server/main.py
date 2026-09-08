import asyncio
import json
import logging
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

logger = logging.getLogger("livekit-meet")

LIVEKIT_URL = os.getenv("LIVEKIT_URL")
LIVEKIT_API_KEY = os.getenv("LIVEKIT_API_KEY")
LIVEKIT_API_SECRET = os.getenv("LIVEKIT_API_SECRET")

CREDENTIALS_READY = bool(LIVEKIT_URL and LIVEKIT_API_KEY and LIVEKIT_API_SECRET)
if not CREDENTIALS_READY:
    # Log loudly but still start: the signaling half works without LiveKit keys,
    # and a running service returning a clear 503 beats a crash loop on boot.
    missing = [
        key
        for key, value in (
            ("LIVEKIT_URL", LIVEKIT_URL),
            ("LIVEKIT_API_KEY", LIVEKIT_API_KEY),
            ("LIVEKIT_API_SECRET", LIVEKIT_API_SECRET),
        )
        if not value
    ]
    logger.error("Missing LiveKit configuration: %s. /getToken will return 503.", ", ".join(missing))

# Guard rails so one misbehaving client cannot exhaust server memory.
MAX_NAME_LENGTH = 128
MAX_ROOM_LENGTH = 128
MAX_FRAME_CHARS = 512 * 1024
MAX_PENDING_KNOCKS = 50
MAX_WHITEBOARD_RECORDS = 10_000

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
            # Closed or half-open socket; the caller prunes it.
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
    """
    Send to many participants, pruning any whose socket has died.

    Must be called *outside* `room.lock`: it takes the lock itself to prune, and
    asyncio locks are not reentrant.
    """
    if not targets:
        return

    results = await asyncio.gather(
        *(p.send(payload) for p in targets), return_exceptions=True
    )
    dead = [p for p, ok in zip(targets, results) if ok is not True]
    if not dead:
        return

    async with room.lock:
        for participant in dead:
            if participant in room.participants:
                room.participants.remove(participant)


def clean_text(value: Any, limit: int, fallback: str = "") -> str:
    """Coerce untrusted input to a bounded, stripped string."""
    if not isinstance(value, str):
        value = "" if value is None else str(value)
    value = value.strip()
    return value[:limit] if value else fallback


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #


@app.get("/")
def health():
    return {
        "status": "ok",
        "livekit_url": LIVEKIT_URL,
        "livekit_configured": CREDENTIALS_READY,
        "active_rooms": len(rooms),
    }


@app.get("/getToken")
def get_token(room_name: str = "", participant_name: str = ""):
    room = clean_text(room_name, MAX_ROOM_LENGTH)
    participant = clean_text(participant_name, MAX_NAME_LENGTH)

    if not room or not participant:
        raise HTTPException(
            status_code=400,
            detail="Both room_name and participant_name are required.",
        )

    if not CREDENTIALS_READY:
        raise HTTPException(
            status_code=503,
            detail="LiveKit credentials are not configured on the server.",
        )

    try:
        token = (
            api.AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
            .with_identity(participant)
            .with_name(participant)
            .with_grants(api.VideoGrants(room_join=True, room=room))
            .to_jwt()
        )
    except Exception:
        logger.exception("Failed to mint an access token for room %r", room)
        raise HTTPException(status_code=500, detail="Could not generate an access token.")

    return {"token": token, "url": LIVEKIT_URL, "room": room, "identity": participant}


# --------------------------------------------------------------------------- #
# WebSocket: waiting room + whiteboard sync
# --------------------------------------------------------------------------- #


async def read_frame(websocket: WebSocket) -> Optional[str]:
    """
    Pull one text frame off the socket.

    Returns None for frames we ignore (binary, empty, oversized) and raises
    WebSocketDisconnect when the peer goes away.
    """
    event = await websocket.receive()

    event_type = event.get("type")
    if event_type == "websocket.disconnect":
        raise WebSocketDisconnect(event.get("code", 1000))

    raw = event.get("text")
    if raw is None:
        payload = event.get("bytes")
        if not payload:
            return None
        raw = payload.decode("utf-8", "replace")

    if not raw or len(raw) > MAX_FRAME_CHARS:
        return None
    return raw


async def handle_message(
    message: Dict[str, Any], me: Participant, room: Room, room_name: str
) -> None:
    """Route a single decoded client frame. Raising here kills only that frame."""
    kind = message.get("type")

    if kind == "knock":
        knocker = clean_text(message.get("name"), MAX_NAME_LENGTH, fallback=me.name)
        me.name = knocker
        async with room.lock:
            hosts = room.hosts
            if not hosts and knocker not in room.pending_knocks:
                if len(room.pending_knocks) < MAX_PENDING_KNOCKS:
                    room.pending_knocks.append(knocker)
                else:
                    logger.warning("Pending knock queue full for room %r", room_name)
        if hosts:
            await fan_out(hosts, {"type": "knock", "name": knocker}, room)
        else:
            await me.send({"type": "waiting", "reason": "host_absent"})

    elif kind == "decision":
        if me.role != "host":
            return  # only the host decides who gets in
        guest_name = clean_text(message.get("name"), MAX_NAME_LENGTH)
        if not guest_name:
            return
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
                if len(data) <= MAX_WHITEBOARD_RECORDS:
                    room.whiteboard = data
                else:
                    logger.warning(
                        "Discarding oversized whiteboard snapshot (%d records) in %r",
                        len(data),
                        room_name,
                    )
            targets = room.others(me)
        await fan_out(targets, {"type": "whiteboard_update", "data": data}, room)

    elif kind == "whiteboard_clear":
        async with room.lock:
            room.whiteboard = []
            targets = room.others(me)
        await fan_out(targets, {"type": "whiteboard_clear"}, room)

    elif kind == "ping":
        await me.send({"type": "pong"})


@app.websocket("/ws/meeting/{room_name}")
async def meeting_socket(
    websocket: WebSocket,
    room_name: str,
    name: str = "Guest",
    role: str = "guest",
):
    room_name = clean_text(room_name, MAX_ROOM_LENGTH, fallback="lobby")
    name = clean_text(name, MAX_NAME_LENGTH, fallback="Guest")
    role = "host" if role == "host" else "guest"

    await websocket.accept()

    room = rooms.setdefault(room_name, Room())
    me = Participant(websocket, name, role)

    async with room.lock:
        room.participants.append(me)
        replay_knocks = list(room.pending_knocks) if role == "host" else []
        if role == "host":
            room.pending_knocks.clear()
        whiteboard_snapshot = list(room.whiteboard)
        hosts_online = len(room.hosts) > 0

    try:
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
            await me.send(
                {"type": "whiteboard_update", "data": whiteboard_snapshot, "snapshot": True}
            )

        # A host arriving after guests knocked still sees those requests.
        for pending_name in replay_knocks:
            await me.send({"type": "knock", "name": pending_name})

        while True:
            try:
                raw = await read_frame(websocket)
            except WebSocketDisconnect:
                break
            except RuntimeError:
                # Socket already closed underneath us.
                break

            if raw is None:
                continue

            try:
                message = json.loads(raw)
            except (ValueError, TypeError):
                await me.send({"type": "error", "reason": "invalid_json"})
                continue

            if not isinstance(message, dict):
                await me.send({"type": "error", "reason": "expected_object"})
                continue

            try:
                await handle_message(message, me, room, room_name)
            except Exception:
                # One bad frame must never take down an active meeting.
                logger.exception(
                    "Error handling %r message in room %r", message.get("type"), room_name
                )
                await me.send({"type": "error", "reason": "server_error"})

    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("Unexpected failure on socket in room %r", room_name)
    finally:
        # Always unregister, and drop the room once the last participant leaves,
        # so disconnects can never leave zombie entries behind.
        async with room.lock:
            if me in room.participants:
                room.participants.remove(me)
            left_empty = room.is_empty()
        if left_empty and rooms.get(room_name) is room:
            rooms.pop(room_name, None)
        try:
            await websocket.close()
        except Exception:
            pass
