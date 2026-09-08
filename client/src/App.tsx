import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LiveKitRoom } from "@livekit/components-react";

import MeetingStage from "./components/MeetingStage";
import { useCopyFeedback } from "./lib/clipboard";
import { useMediaDevices } from "./lib/useMediaDevices";
import { useMeetingSocket, type MeetingMessage } from "./lib/useMeetingSocket";
import { createWhiteboardBus } from "./lib/whiteboardBus";

const LIVEKIT_URL =
  import.meta.env.VITE_LIVEKIT_URL ?? "wss://video-meet-4jll05v3.livekit.cloud";
const TOKEN_ENDPOINT =
  import.meta.env.VITE_API_URL ?? "http://localhost:8000/getToken";

const NAME_STORAGE_KEY = "lk-display-name";
const DEFAULT_HOST_NAME = "Love Kumar Todawat";
const ROOM_CODE_ALPHABET = "abcdefghijkmnopqrstuvwxyz";

/** Nine letters, grouped Meet-style as `abc-def-ghi`. */
function randomRoomName() {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  const letters = Array.from(
    bytes,
    (b) => ROOM_CODE_ALPHABET[b % ROOM_CODE_ALPHABET.length],
  ).join("");
  return `${letters.slice(0, 3)}-${letters.slice(3, 6)}-${letters.slice(6, 9)}`;
}

/** A room in the URL (?room=...) is an invite: it is locked in and cannot be edited. */
function roomFromUrl() {
  return new URLSearchParams(window.location.search).get("room");
}

function storedName() {
  try {
    return localStorage.getItem(NAME_STORAGE_KEY);
  } catch {
    return null;
  }
}

function rememberName(name: string) {
  try {
    localStorage.setItem(NAME_STORAGE_KEY, name);
  } catch {
    // Private-mode browsers can refuse writes; remembering the name is optional.
  }
}

/** Accepts a bare code, a full invite URL, or anything with a `room` query param. */
function parseRoomInput(raw: string) {
  const value = raw.trim();
  if (!value) return "";

  if (value.includes("://") || value.includes("?room=")) {
    try {
      const url = new URL(value, window.location.origin);
      const room = url.searchParams.get("room");
      if (room) return room.trim();
      const lastSegment = url.pathname.split("/").filter(Boolean).pop();
      if (lastSegment) return lastSegment;
    } catch {
      // Not a parseable URL; fall through and use the raw value as a code.
    }
  }
  return value;
}

function inviteLinkFor(room: string) {
  return window.location.origin + "?room=" + encodeURIComponent(room.trim());
}

type View = "dashboard" | "prep" | "waiting";

export default function App() {
  const invitedRoom = useMemo(() => roomFromUrl(), []);
  const isInvited = Boolean(invitedRoom);

  // An invite link skips the dashboard and lands straight on the prep view.
  const [view, setView] = useState<View>(isInvited ? "prep" : "dashboard");
  const [roomName, setRoomName] = useState(() => invitedRoom ?? "");
  const [userName, setUserName] = useState(
    // Guests arriving on an invite link get a blank field; the host gets a default.
    () => storedName() ?? (isInvited ? "" : DEFAULT_HOST_NAME),
  );

  // Whoever creates the meeting hosts it; everyone else has to ask to join.
  const [isHost, setIsHost] = useState(false);

  const [token, setToken] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [joinCode, setJoinCode] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [laterRoom, setLaterRoom] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Guests waiting on the host, seen from the host's side.
  const [knocks, setKnocks] = useState<string[]>([]);

  // Bumped when the host denies entry, which tears the guest socket down.
  const [deniedAt, setDeniedAt] = useState(0);

  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  // Missing hardware must not block joining: fall back to receive-only.
  const { hasCamera, hasMic, checked: devicesChecked } = useMediaDevices();

  const bus = useMemo(() => createWhiteboardBus(), []);

  const fetchToken = useCallback(async (room: string, participant: string) => {
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
    return data.token as string;
  }, []);

  const handleSocketMessage = useCallback(
    (message: MeetingMessage) => {
      switch (message.type) {
        case "knock": {
          const who = String(message.name ?? "Someone");
          setKnocks((prev) => (prev.includes(who) ? prev : [...prev, who]));
          break;
        }
        case "decision": {
          if (message.approved) {
            setNotice("");
            fetchToken(roomName.trim(), userName.trim())
              .then((t) => {
                rememberName(userName.trim());
                setToken(t);
              })
              .catch((err) =>
                setError(
                  err instanceof Error ? err.message : "Could not fetch a token.",
                ),
              );
          } else {
            setDeniedAt(Date.now());
            setView("prep");
            setError("The host denied your request to join.");
          }
          break;
        }
        case "waiting": {
          if (message.reason === "host_absent") {
            setNotice("The host has not joined yet. You will be let in once they do.");
          }
          break;
        }
        case "whiteboard_update": {
          bus.publish(message.data);
          break;
        }
        case "whiteboard_clear": {
          bus.publish([]);
          break;
        }
      }
    },
    [bus, fetchToken, roomName, userName],
  );

  const handleSocketClose = useCallback(() => {
    setKnocks([]);
    if (viewRef.current === "waiting") {
      setView("prep");
      setError("Lost connection to the meeting server. Please try again.");
    }
  }, []);

  const socket = useMeetingSocket({
    onMessage: handleSocketMessage,
    onUnexpectedClose: handleSocketClose,
  });
  // `disconnect` is stable, so this only fires when a denial actually lands.
  const { disconnect } = socket;
  useEffect(() => {
    if (deniedAt) disconnect();
  }, [deniedAt, disconnect]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  const goToPrep = useCallback((room: string, asHost: boolean) => {
    setRoomName(room);
    setIsHost(asHost);
    setError("");
    setNotice("");
    setMenuOpen(false);
    setView("prep");
  }, []);

  const handleCreateForLater = useCallback(() => {
    setLaterRoom(randomRoomName());
    setMenuOpen(false);
  }, []);

  const handleInstantMeeting = useCallback(() => {
    goToPrep(randomRoomName(), true);
  }, [goToPrep]);

  const handleJoinByCode = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const room = parseRoomInput(joinCode);
      if (!room) {
        setError("Enter a meeting code or invite link.");
        return;
      }
      goToPrep(room, false);
    },
    [joinCode, goToPrep],
  );

  /** Host: open signaling, then join LiveKit straight away. */
  const startAsHost = useCallback(
    async (room: string, participant: string) => {
      await socket.connect(room, participant, "host");
      const t = await fetchToken(room, participant);
      rememberName(participant);
      setToken(t);
    },
    [fetchToken, socket],
  );

  /** Guest: knock and wait. No token is requested until the host approves. */
  const askToJoin = useCallback(
    async (room: string, participant: string) => {
      await socket.connect(room, participant, "guest");
      socket.send({ type: "knock", name: participant });
      setView("waiting");
    },
    [socket],
  );

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
      setNotice("");
      setConnecting(true);
      try {
        if (isHost) {
          await startAsHost(room, participant);
        } else {
          await askToJoin(room, participant);
        }
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Could not reach the meeting server.",
        );
      } finally {
        setConnecting(false);
      }
    },
    [askToJoin, isHost, roomName, startAsHost, userName],
  );

  const decide = useCallback(
    (name: string, approved: boolean) => {
      socket.send({ type: "decision", name, approved });
      setKnocks((prev) => prev.filter((n) => n !== name));
    },
    [socket],
  );

  const leaveRoom = useCallback(() => {
    setToken(null);
    setKnocks([]);
    bus.reset();
    socket.disconnect();
    // An invited guest has nowhere to go back to but their own prep view.
    setView(isInvited ? "prep" : "dashboard");
  }, [bus, isInvited, socket]);

  const cancelWaiting = useCallback(() => {
    socket.disconnect();
    setNotice("");
    setView("prep");
  }, [socket]);

  if (token) {
    return (
      <div className="relative h-dvh w-full bg-[#0a0a0c]">
        <LiveKitRoom
          video={hasCamera}
          audio={hasMic}
          connect
          token={token}
          serverUrl={LIVEKIT_URL}
          data-lk-theme="default"
          style={{ height: "100dvh" }}
          onDisconnected={leaveRoom}
          onError={(err) => {
            setError(err.message);
            leaveRoom();
          }}
        >
          <MeetingStage roomName={roomName} bus={bus} send={socket.send} />
        </LiveKitRoom>

        {isHost && knocks.length > 0 && (
          <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
            {knocks.map((name) => (
              <KnockToast
                key={name}
                name={name}
                onAdmit={() => decide(name, true)}
                onDeny={() => decide(name, false)}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="relative flex min-h-dvh w-full flex-col overflow-hidden bg-[#0a0a0c]">
      <Backdrop />

      <header className="relative z-10 flex items-center gap-2.5 px-6 py-5 sm:px-10">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/10">
          <CameraIcon />
        </span>
        <span className="text-[15px] font-medium tracking-tight text-zinc-200">
          LiveKit Meet
        </span>
      </header>

      <main className="relative z-10 flex flex-1 items-center justify-center px-4 pb-16 sm:px-10">
        {view === "dashboard" && (
          <Dashboard
            joinCode={joinCode}
            setJoinCode={setJoinCode}
            onJoinByCode={handleJoinByCode}
            menuOpen={menuOpen}
            setMenuOpen={setMenuOpen}
            menuRef={menuRef}
            onCreateForLater={handleCreateForLater}
            onInstantMeeting={handleInstantMeeting}
            error={error}
          />
        )}

        {view === "prep" && (
          <PrepView
            roomName={roomName}
            setRoomName={setRoomName}
            userName={userName}
            setUserName={setUserName}
            isInvited={isInvited}
            isHost={isHost}
            hasCamera={hasCamera}
            hasMic={hasMic}
            devicesChecked={devicesChecked}
            connecting={connecting}
            error={error}
            onJoin={handleJoin}
            onBack={isInvited ? undefined : () => setView("dashboard")}
          />
        )}

        {view === "waiting" && (
          <WaitingRoom
            roomName={roomName}
            userName={userName}
            notice={notice}
            onCancel={cancelWaiting}
          />
        )}
      </main>

      {laterRoom && (
        <ShareModal
          room={laterRoom}
          onClose={() => setLaterRoom(null)}
          onJoinNow={() => {
            const room = laterRoom;
            setLaterRoom(null);
            goToPrep(room, true);
          }}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- dashboard */

function Dashboard({
  joinCode,
  setJoinCode,
  onJoinByCode,
  menuOpen,
  setMenuOpen,
  menuRef,
  onCreateForLater,
  onInstantMeeting,
  error,
}: {
  joinCode: string;
  setJoinCode: (v: string) => void;
  onJoinByCode: (e: React.FormEvent) => void;
  menuOpen: boolean;
  setMenuOpen: (v: boolean) => void;
  menuRef: React.RefObject<HTMLDivElement | null>;
  onCreateForLater: () => void;
  onInstantMeeting: () => void;
  error: string;
}) {
  return (
    <div className="w-full max-w-3xl animate-fade-up">
      <h1 className="text-balance text-center text-4xl font-semibold tracking-tight text-white sm:text-5xl">
        Video calls, built on LiveKit
      </h1>
      <p className="mx-auto mt-4 max-w-xl text-center text-base text-zinc-400">
        Start a meeting in one click, or join with a code someone shared with you.
      </p>

      <div className="mt-10 flex flex-col items-stretch gap-4 sm:flex-row sm:items-start sm:justify-center">
        {/* New meeting + dropdown */}
        <div ref={menuRef} className="relative sm:w-auto">
          <button
            type="button"
            onClick={() => setMenuOpen(!menuOpen)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-500 px-5 py-3.5 text-sm font-medium text-white shadow-lg shadow-indigo-500/20 transition hover:bg-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-400/60 sm:w-auto"
          >
            <PlusIcon />
            New meeting
            <ChevronIcon open={menuOpen} />
          </button>

          {menuOpen && (
            <div
              role="menu"
              className="absolute left-0 right-0 z-30 mt-2 overflow-hidden rounded-xl border border-white/10 bg-[#141418] p-1.5 shadow-2xl sm:right-auto sm:w-80"
            >
              <MenuItem
                icon={<LinkIcon />}
                title="Create a meeting for later"
                description="Get a link you can share now and use anytime"
                onClick={onCreateForLater}
              />
              <MenuItem
                icon={<CameraIcon />}
                title="Start an instant meeting"
                description="Create a room and join it right away"
                onClick={onInstantMeeting}
              />
            </div>
          )}
        </div>

        {/* Join by code */}
        <form onSubmit={onJoinByCode} className="flex flex-1 gap-2 sm:max-w-md">
          <div className="relative flex-1">
            <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-500">
              <KeyboardIcon />
            </span>
            <input
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
              placeholder="Enter a code or link"
              spellCheck={false}
              aria-label="Meeting code or link"
              className="w-full rounded-xl border border-white/10 bg-white/[0.06] py-3.5 pl-11 pr-4 text-sm text-white placeholder-zinc-500 outline-none transition focus:border-indigo-400/50 focus:ring-2 focus:ring-indigo-500/30"
            />
          </div>
          <button
            type="submit"
            disabled={!joinCode.trim()}
            className="rounded-xl px-5 py-3.5 text-sm font-medium text-indigo-300 transition hover:bg-white/[0.06] focus:outline-none focus:ring-2 focus:ring-indigo-400/40 disabled:cursor-not-allowed disabled:text-zinc-600 disabled:hover:bg-transparent"
          >
            Join
          </button>
        </form>
      </div>

      {error && (
        <p role="alert" className="mt-5 text-center text-sm text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}

function MenuItem({
  icon,
  title,
  description,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-start gap-3 rounded-lg px-3 py-3 text-left transition hover:bg-white/[0.07] focus:bg-white/[0.07] focus:outline-none"
    >
      <span className="mt-0.5 shrink-0 text-zinc-400">{icon}</span>
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-zinc-100">{title}</span>
        <span className="text-xs text-zinc-500">{description}</span>
      </span>
    </button>
  );
}

/* ----------------------------------------------------------------- prep view */

/** Explains what a participant will join with when hardware is missing. */
function deviceNotice(hasCamera: boolean, hasMic: boolean) {
  if (!hasCamera && !hasMic) {
    return "No camera or microphone detected. You can still join to watch and listen.";
  }
  if (!hasCamera) {
    return "No camera detected. You will join with audio only.";
  }
  return "No microphone detected. You will join with video only.";
}

function PrepView({
  roomName,
  setRoomName,
  userName,
  setUserName,
  isInvited,
  isHost,
  hasCamera,
  hasMic,
  devicesChecked,
  connecting,
  error,
  onJoin,
  onBack,
}: {
  roomName: string;
  setRoomName: (v: string) => void;
  userName: string;
  setUserName: (v: string) => void;
  isInvited: boolean;
  isHost: boolean;
  hasCamera: boolean;
  hasMic: boolean;
  devicesChecked: boolean;
  connecting: boolean;
  error: string;
  onJoin: (e: React.FormEvent) => void;
  onBack?: () => void;
}) {
  const { copied, copy } = useCopyFeedback();

  const copyInvite = useCallback(() => {
    void copy(inviteLinkFor(roomName));
  }, [copy, roomName]);

  const joinLabel = isHost ? "Join meeting" : "Ask to Join";

  return (
    <div className="w-full max-w-md animate-fade-up">
      <div className="rounded-3xl border border-white/10 bg-gradient-to-b from-white/[0.08] to-white/[0.02] p-8 shadow-2xl backdrop-blur-xl">
        <div className="flex flex-col items-center">
          <span className="relative mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/10 shadow-lg">
            <span className="absolute inset-0 animate-pulse-ring rounded-2xl border border-indigo-400/40" />
            <CameraIcon />
          </span>
          <h1 className="text-center text-2xl font-semibold tracking-tight text-white">
            {isHost ? "Ready to start?" : "Ask to join this meeting"}
          </h1>
          <p className="mt-2 text-center text-sm text-zinc-400">
            {isHost
              ? "You are the host. Share the invite link to bring others in."
              : "The host will be asked to let you in."}
          </p>
        </div>

        <form onSubmit={onJoin} className="mt-8 flex flex-col gap-4">
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

          {devicesChecked && !(hasCamera && hasMic) && (
            <p className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
              {deviceNotice(hasCamera, hasMic)}
            </p>
          )}

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
            {connecting ? "Connecting..." : joinLabel}
          </button>

          <button
            type="button"
            onClick={copyInvite}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-5 py-3 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.08] focus:outline-none focus:ring-2 focus:ring-white/20"
          >
            <LinkIcon />
            {copied ? "Invite link copied" : "Copy invite link"}
          </button>
        </form>
      </div>

      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="mx-auto mt-5 block text-sm text-zinc-500 transition hover:text-zinc-300"
        >
          &larr; Back to home
        </button>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- waiting room */

function WaitingRoom({
  roomName,
  userName,
  notice,
  onCancel,
}: {
  roomName: string;
  userName: string;
  notice: string;
  onCancel: () => void;
}) {
  return (
    <div className="w-full max-w-md animate-fade-up text-center">
      <div className="rounded-3xl border border-white/10 bg-gradient-to-b from-white/[0.08] to-white/[0.02] p-10 shadow-2xl backdrop-blur-xl">
        <span className="relative mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full border border-white/10 bg-white/10">
          <span className="absolute inset-0 animate-pulse-ring rounded-full border border-indigo-400/40" />
          <span className="h-3 w-3 animate-pulse rounded-full bg-indigo-400" />
        </span>

        <h1 className="text-2xl font-semibold tracking-tight text-white">
          Waiting for the host...
        </h1>
        <p className="mt-3 text-sm text-zinc-400">
          We let the host know you are here. You will join automatically once you
          are admitted.
        </p>

        {notice && (
          <p className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
            {notice}
          </p>
        )}

        <dl className="mt-6 space-y-1 text-xs text-zinc-500">
          <div>
            Room <span className="font-mono text-zinc-300">{roomName}</span>
          </div>
          <div>
            Joining as <span className="text-zinc-300">{userName}</span>
          </div>
        </dl>

        <button
          type="button"
          onClick={onCancel}
          className="mt-7 w-full rounded-xl border border-white/10 bg-white/[0.04] px-5 py-2.5 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.08] focus:outline-none focus:ring-2 focus:ring-white/20"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- knock toast */

function KnockToast({
  name,
  onAdmit,
  onDeny,
}: {
  name: string;
  onAdmit: () => void;
  onDeny: () => void;
}) {
  return (
    <div
      role="alert"
      className="w-80 animate-fade-up rounded-2xl border border-white/10 bg-[#16161b]/95 p-4 shadow-2xl backdrop-blur-md"
    >
      <p className="text-sm text-zinc-100">
        <span className="font-medium">{name}</span> is asking to join
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onAdmit}
          className="flex-1 rounded-lg bg-indigo-500 px-3 py-2 text-sm font-medium text-white transition hover:bg-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-400/60"
        >
          Admit
        </button>
        <button
          type="button"
          onClick={onDeny}
          className="flex-1 rounded-lg border border-white/10 bg-white/[0.05] px-3 py-2 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.1] focus:outline-none focus:ring-2 focus:ring-white/20"
        >
          Deny
        </button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- share modal */

function ShareModal({
  room,
  onClose,
  onJoinNow,
}: {
  room: string;
  onClose: () => void;
  onJoinNow: () => void;
}) {
  const { copied, copy } = useCopyFeedback();
  const link = inviteLinkFor(room);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const onCopy = useCallback(() => {
    void copy(link);
  }, [copy, link]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Your meeting link"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md animate-fade-up rounded-2xl border border-white/10 bg-[#141418] p-6 shadow-2xl"
      >
        <h2 className="text-lg font-semibold text-white">
          Here is your joining info
        </h2>
        <p className="mt-2 text-sm text-zinc-400">
          Send this link to people you want in the meeting. Save it &mdash; you can
          use it anytime.
        </p>

        <div className="mt-5 flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.05] px-4 py-3">
          <span className="flex-1 truncate font-mono text-sm text-zinc-200">
            {link}
          </span>
          <button
            type="button"
            onClick={onCopy}
            className={[
              "shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition focus:outline-none focus:ring-2 focus:ring-indigo-400/40",
              copied
                ? "bg-emerald-500/20 text-emerald-200"
                : "bg-indigo-500/20 text-indigo-200 hover:bg-indigo-500/30",
            ].join(" ")}
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>

        <p className="mt-4 text-xs text-zinc-500">
          Meeting code: <span className="font-mono text-zinc-300">{room}</span>
        </p>

        <div className="mt-6 flex gap-2">
          <button
            type="button"
            onClick={onJoinNow}
            className="flex-1 rounded-xl bg-indigo-500 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-400/60"
          >
            Start it now
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-xl border border-white/10 bg-white/[0.04] px-5 py-2.5 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.08] focus:outline-none focus:ring-2 focus:ring-white/20"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- shared bits */

function Backdrop() {
  return (
    <div className="pointer-events-none absolute inset-0">
      <div className="absolute left-1/2 top-[-18rem] h-[36rem] w-[36rem] -translate-x-1/2 rounded-full bg-indigo-500/20 blur-[140px]" />
      <div className="absolute bottom-[-16rem] right-[-10rem] h-[32rem] w-[32rem] rounded-full bg-sky-500/10 blur-[140px]" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_35%,#0a0a0c_100%)]" />
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
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="text-indigo-300">
      <path d="m22 8-6 4 6 4V8Z" />
      <rect width="14" height="12" x="2" y="6" rx="2" ry="2" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`transition-transform ${open ? "rotate-180" : ""}`}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function KeyboardIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect width="20" height="14" x="2" y="5" rx="2" />
      <path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M8 13h8" />
    </svg>
  );
}
