import { useCallback, useMemo, useState } from "react";
import { LiveKitRoom, VideoConference } from "@livekit/components-react";

const LIVEKIT_URL =
  import.meta.env.VITE_LIVEKIT_URL ?? "wss://video-meet-4jll05v3.livekit.cloud";
const TOKEN_ENDPOINT =
  import.meta.env.VITE_API_URL ?? "http://localhost:8000/getToken";

const ROOM_CODE_ALPHABET = "abcdefghijkmnopqrstuvwxyz23456789";

function randomRoomName(length = 9) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(
    bytes,
    (b) => ROOM_CODE_ALPHABET[b % ROOM_CODE_ALPHABET.length],
  ).join("");
}

/** A room in the URL (?room=...) is an invite: it is locked in and cannot be edited. */
function roomFromUrl() {
  return new URLSearchParams(window.location.search).get("room");
}

export default function App() {
  const invitedRoom = useMemo(roomFromUrl, []);
  const isInvited = Boolean(invitedRoom);

  const [roomName, setRoomName] = useState(() => invitedRoom ?? randomRoomName());
  const [userName, setUserName] = useState("Love Kumar Todawat");
  const [token, setToken] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const inviteLink =
    window.location.origin + "?room=" + encodeURIComponent(roomName.trim());

  const copyInviteLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(inviteLink);
    } catch {
      // The async clipboard API needs a secure context; fall back to a selection copy.
      const el = document.createElement("textarea");
      el.value = inviteLink;
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }, [inviteLink]);

  const handleJoin = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();

      const room = roomName.trim();
      const participant = userName.trim();
      if (!room || !participant) {
        setError("Please enter both a room name and your name.");
        return;
      }

      setError("");
      setConnecting(true);
      try {
        const url = new URL(TOKEN_ENDPOINT, window.location.origin);
        url.searchParams.set("room_name", room);
        url.searchParams.set("participant_name", participant);

        const response = await fetch(url.toString());
        if (!response.ok) {
          throw new Error(`Token server responded with ${response.status}`);
        }
        const data = await response.json();
        if (!data?.token) {
          throw new Error("Token server did not return a token.");
        }
        setToken(data.token);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Could not reach the token server.",
        );
      } finally {
        setConnecting(false);
      }
    },
    [roomName, userName],
  );

  if (token) {
    return (
      <LiveKitRoom
        video
        audio
        connect
        token={token}
        serverUrl={LIVEKIT_URL}
        data-lk-theme="default"
        style={{ height: "100dvh" }}
        onDisconnected={() => setToken(null)}
        onError={(err) => {
          setError(err.message);
          setToken(null);
        }}
      >
        <VideoConference />
      </LiveKitRoom>
    );
  }

  return (
    <div className="relative flex min-h-dvh w-full flex-col items-center justify-center overflow-hidden bg-[#0a0a0c] px-4 py-12">
      {/* Ambient background wash */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-[-18rem] h-[36rem] w-[36rem] -translate-x-1/2 rounded-full bg-indigo-500/20 blur-[140px]" />
        <div className="absolute bottom-[-16rem] right-[-10rem] h-[32rem] w-[32rem] rounded-full bg-sky-500/10 blur-[140px]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_35%,#0a0a0c_100%)]" />
      </div>

      <main className="relative z-10 w-full max-w-md animate-fade-up">
        <div className="rounded-3xl border border-white/10 bg-gradient-to-b from-white/[0.08] to-white/[0.02] p-8 shadow-2xl backdrop-blur-xl">
          <div className="flex flex-col items-center">
            <span className="relative mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/10 shadow-lg">
              <span className="absolute inset-0 animate-pulse-ring rounded-2xl border border-indigo-400/40" />
              <CameraIcon />
            </span>
            <h1 className="text-center text-2xl font-semibold tracking-tight text-white">
              {isInvited ? "You are invited to a meeting" : "Start a secure meeting"}
            </h1>
            <p className="mt-2 text-center text-sm text-zinc-400">
              {isInvited
                ? "Enter your name to join the room below."
                : "Share the invite link to bring others into your room."}
            </p>
          </div>

          <form onSubmit={handleJoin} className="mt-8 flex flex-col gap-4">
            <Field label="Room">
              <input
                value={roomName}
                onChange={(e) => setRoomName(e.target.value)}
                readOnly={isInvited}
                aria-readonly={isInvited}
                spellCheck={false}
                placeholder="room-name"
                className={[
                  "w-full rounded-xl border border-white/10 bg-white/[0.06] px-4 py-3 font-mono text-sm text-white",
                  "placeholder-zinc-500 outline-none transition focus:border-indigo-400/50 focus:ring-2 focus:ring-indigo-500/30",
                  isInvited ? "cursor-not-allowed text-zinc-300 opacity-80" : "",
                ].join(" ")}
              />
              {isInvited && (
                <p className="mt-1.5 text-xs text-zinc-500">
                  Locked to the room from your invite link.
                </p>
              )}
            </Field>

            <Field label="Your name">
              <input
                value={userName}
                onChange={(e) => setUserName(e.target.value)}
                autoFocus
                placeholder="Your name"
                className="w-full rounded-xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm text-white placeholder-zinc-500 outline-none transition focus:border-indigo-400/50 focus:ring-2 focus:ring-indigo-500/30"
              />
            </Field>

            {error && (
              <p
                role="alert"
                className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300"
              >
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={connecting}
              className="mt-1 flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-500 px-5 py-3 text-sm font-medium text-white shadow-lg shadow-indigo-500/20 transition hover:bg-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-400/60 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {connecting ? "Connecting..." : "Join meeting"}
            </button>

            <button
              type="button"
              onClick={copyInviteLink}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-5 py-3 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.08] focus:outline-none focus:ring-2 focus:ring-white/20"
            >
              <LinkIcon />
              {copied ? "Invite link copied" : "Copy invite link"}
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-xs text-zinc-600">
          Powered by LiveKit Cloud
        </p>
      </main>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium uppercase tracking-wider text-zinc-400">
        {label}
      </span>
      {children}
    </label>
  );
}

function CameraIcon() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-indigo-300"
    >
      <path d="m22 8-6 4 6 4V8Z" />
      <rect width="14" height="12" x="2" y="6" rx="2" ry="2" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}
