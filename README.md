# LiveKit Full-Stack Meet

A cloud-ready video conferencing app: a FastAPI token server plus a React (Vite + TypeScript)
frontend built on LiveKit Cloud.

## Structure

| Path      | What it is                                                   |
| --------- | ------------------------------------------------------------ |
| `server/` | FastAPI token server exposing `GET /getToken`                 |
| `client/` | React + Vite + Tailwind frontend using LiveKit components     |

## Local development

### Backend

```bash
cd server
python -m venv .venv
.venv/Scripts/activate        # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

The server reads `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` from the
repository-root `.env` (see `.env.example`) or from real environment variables.

### Frontend

```bash
cd client
npm install
npm run dev
```

Configure `client/.env` (see `client/.env.example`) to point at a deployed backend:

- `VITE_API_URL` — full token endpoint URL, defaults to `http://localhost:8000/getToken`
- `VITE_LIVEKIT_URL` — LiveKit Cloud websocket URL

## Features

- Meet-style dashboard: "New meeting" (create for later / start instantly) and
  join-by-code, which accepts a bare code or a full invite link
- Room codes are nine letters grouped as `abc-def-ghi`
- `?room=<name>` in the URL locks the room in and only asks for a display name
- Display name is remembered in `localStorage` after a successful join
- **Ask to Join waiting room**: the creator is the host and joins immediately;
  everyone else knocks and waits until the host admits them
- In-call chat sidebar (LiveKit `<Chat />`), screen sharing, and a copy-link pill
- Collaborative whiteboard (tldraw) synced across participants

## Signaling API

`GET /getToken?room_name=<room>&participant_name=<name>` returns:

```json
{ "token": "<jwt>", "url": "wss://...", "room": "...", "identity": "..." }
```

`WS /ws/meeting/{room_name}?name=<name>&role=host|guest` carries the waiting room
and whiteboard traffic:

| Message | Direction | Effect |
| ------- | --------- | ------ |
| `{"type":"knock","name":...}` | guest to server | forwarded to the host; queued if no host is connected yet |
| `{"type":"decision","name":...,"approved":bool}` | host to server | forwarded to that guest; ignored from non-hosts |
| `{"type":"whiteboard_update","data":...}` | any | broadcast to everyone else in the room |

Room state is in-memory, so it is per-process and resets on restart.

## Deployment

Both services deploy to Render from this repository:

- **Backend** — web service, root dir `server`, build `pip install -r requirements.txt`,
  start `uvicorn main:app --host 0.0.0.0 --port $PORT`
- **Frontend** — static site, root dir `client`, build `npm install && npm run build`,
  publish path `dist`

After the backend is live, set `VITE_API_URL` on the frontend service to
`https://<backend-host>/getToken` and redeploy so the client talks to the deployed API.
