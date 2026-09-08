import { Suspense, lazy, useCallback, useState } from "react";
import { Chat, VideoConference } from "@livekit/components-react";

import type { MeetingMessage } from "../lib/useMeetingSocket";
import type { WhiteboardBus } from "../lib/whiteboardBus";

const Whiteboard = lazy(() => import("./Whiteboard"));

type Props = {
  roomName: string;
  bus: WhiteboardBus;
  send: (message: MeetingMessage) => boolean;
};

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // The async clipboard API needs a secure context; fall back to a selection copy.
    const el = document.createElement("textarea");
    el.value = text;
    document.body.appendChild(el);
    el.select();
    document.execCommand("copy");
    document.body.removeChild(el);
  }
}

/**
 * Everything inside the LiveKit room: the prebuilt conference (grid, screen
 * share and chat plumbing), plus our chat sidebar, whiteboard and copy pill.
 */
export default function MeetingStage({ roomName, bus, send }: Props) {
  const [chatOpen, setChatOpen] = useState(false);
  const [boardOpen, setBoardOpen] = useState(false);

  return (
    <div className="flex h-dvh w-full bg-[#0a0a0c]">
      <div className="relative min-w-0 flex-1">
        <VideoConference />

        {boardOpen && (
          <div className="absolute inset-0 z-30 bg-[#0a0a0c]">
            <Suspense fallback={<BoardLoading />}>
              <Whiteboard bus={bus} send={send} />
            </Suspense>
          </div>
        )}

        {/* Floating toolbar, clear of LiveKit's centred control bar. */}
        <div className="absolute right-4 top-4 z-40 flex gap-2">
          <ToolbarButton
            active={boardOpen}
            onClick={() => setBoardOpen((v) => !v)}
            label={boardOpen ? "Close whiteboard" : "Whiteboard"}
          >
            <PenIcon />
          </ToolbarButton>
          <ToolbarButton
            active={chatOpen}
            onClick={() => setChatOpen((v) => !v)}
            label={chatOpen ? "Close chat" : "Chat"}
          >
            <ChatIcon />
          </ToolbarButton>
        </div>

        <div className="absolute bottom-4 left-4 z-40">
          <CopyLinkPill room={roomName} />
        </div>
      </div>

      {/* LiveKit's own <Chat/>, hosted in a sidebar we control. */}
      <aside
        className={[
          "relative z-40 h-full shrink-0 overflow-hidden border-l border-white/10 bg-[#111114]",
          "transition-[width] duration-200",
          chatOpen ? "w-80" : "w-0 border-l-0",
        ].join(" ")}
      >
        {chatOpen && (
          <div className="flex h-full flex-col">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
              <span className="text-sm font-medium text-zinc-200">In-call messages</span>
              <button
                type="button"
                onClick={() => setChatOpen(false)}
                aria-label="Close chat"
                className="rounded-md p-1 text-zinc-400 transition hover:bg-white/10 hover:text-white"
              >
                <CloseIcon />
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <Chat />
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}

function BoardLoading() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-zinc-400">
      Loading whiteboard...
    </div>
  );
}

function ToolbarButton({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={[
        "flex items-center gap-2 rounded-full border px-4 py-2.5 text-sm font-medium backdrop-blur-md transition",
        "focus:outline-none focus:ring-2 focus:ring-white/30",
        active
          ? "border-indigo-400/40 bg-indigo-500/25 text-indigo-100"
          : "border-white/15 bg-black/50 text-zinc-100 hover:bg-black/70",
      ].join(" ")}
    >
      {children}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

function CopyLinkPill({ room }: { room: string }) {
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(async () => {
    await copyText(window.location.origin + "?room=" + room);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }, [room]);

  return (
    <button
      type="button"
      onClick={onCopy}
      aria-live="polite"
      className={[
        "flex items-center gap-2 rounded-full border px-4 py-2.5 text-sm font-medium",
        "backdrop-blur-md transition focus:outline-none focus:ring-2 focus:ring-white/30",
        copied
          ? "border-emerald-400/30 bg-emerald-500/20 text-emerald-200"
          : "border-white/15 bg-black/50 text-zinc-100 hover:bg-black/70",
      ].join(" ")}
    >
      {copied ? <CheckIcon /> : <LinkIcon />}
      {copied ? "Copied!" : "Copy link"}
    </button>
  );
}

/* --------------------------------------------------------------------- icons */

function PenIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 19l7-7 3 3-7 7-3-3z" />
      <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
      <path d="M2 2l7.586 7.586" />
      <circle cx="11" cy="11" r="2" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18M6 6l12 12" />
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

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
