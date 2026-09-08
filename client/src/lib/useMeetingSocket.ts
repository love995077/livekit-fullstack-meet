import { useCallback, useEffect, useRef, useState } from "react";

export type MeetingMessage = {
  type: string;
  [key: string]: unknown;
};

export type SocketRole = "host" | "guest";

const TOKEN_ENDPOINT =
  import.meta.env.VITE_API_URL ?? "http://localhost:8000/getToken";

/** Derive the signaling origin from the token endpoint unless one is set explicitly. */
export function meetingSocketUrl(room: string, name: string, role: SocketRole) {
  const explicit = import.meta.env.VITE_WS_URL;
  const base = explicit
    ? explicit.replace(/\/$/, "")
    : new URL(TOKEN_ENDPOINT, window.location.origin).origin.replace(
        /^http/,
        "ws",
      );
  const query = new URLSearchParams({ name, role });
  return `${base}/ws/meeting/${encodeURIComponent(room)}?${query}`;
}

type Options = {
  onMessage: (message: MeetingMessage) => void;
  /** Fires only for drops after a successful connect, never for our own close(). */
  onUnexpectedClose?: () => void;
};

/**
 * A single meeting WebSocket, opened on demand and kept for the whole session:
 * it carries the waiting-room handshake first and whiteboard updates afterwards.
 */
export function useMeetingSocket({ onMessage, onUnexpectedClose }: Options) {
  const socketRef = useRef<WebSocket | null>(null);
  const messageHandlerRef = useRef(onMessage);
  const closeHandlerRef = useRef(onUnexpectedClose);
  // Set while we tear a socket down deliberately, so its close is not "unexpected".
  const closingRef = useRef(false);
  const [connected, setConnected] = useState(false);

  // Keep the latest handlers without tearing down the socket on every render.
  useEffect(() => {
    messageHandlerRef.current = onMessage;
  }, [onMessage]);
  useEffect(() => {
    closeHandlerRef.current = onUnexpectedClose;
  }, [onUnexpectedClose]);

  const disconnect = useCallback(() => {
    const socket = socketRef.current;
    socketRef.current = null;
    setConnected(false);
    if (socket && socket.readyState <= WebSocket.OPEN) {
      closingRef.current = true;
      socket.close();
      closingRef.current = false;
    }
  }, []);

  const connect = useCallback(
    (room: string, name: string, role: SocketRole) =>
      new Promise<WebSocket>((resolve, reject) => {
        // Reconnecting with a different role/room replaces the old socket.
        const previous = socketRef.current;
        if (previous) {
          previous.onclose = null;
          previous.onerror = null;
          previous.onmessage = null;
          previous.close();
        }

        let socket: WebSocket;
        try {
          socket = new WebSocket(meetingSocketUrl(room, name, role));
        } catch (err) {
          reject(
            err instanceof Error ? err : new Error("Could not open a meeting socket."),
          );
          return;
        }
        socketRef.current = socket;

        // The handshake must always settle the promise exactly once: a socket
        // that closes before opening would otherwise leave the caller hanging.
        let settled = false;
        const settle = (fn: () => void) => {
          if (settled) return;
          settled = true;
          fn();
        };

        socket.onopen = () => {
          setConnected(true);
          settle(() => resolve(socket));
        };

        socket.onerror = () => {
          settle(() => reject(new Error("Could not reach the meeting server.")));
        };

        socket.onclose = () => {
          const wasCurrent = socketRef.current === socket;
          if (wasCurrent) {
            socketRef.current = null;
            setConnected(false);
          }
          if (!settled) {
            settle(() => reject(new Error("Could not reach the meeting server.")));
          } else if (wasCurrent && !closingRef.current) {
            closeHandlerRef.current?.();
          }
        };

        socket.onmessage = (event) => {
          try {
            const parsed = JSON.parse(event.data);
            if (parsed && typeof parsed === "object") {
              messageHandlerRef.current(parsed as MeetingMessage);
            }
          } catch {
            // Ignore frames that are not JSON objects.
          }
        };
      }),
    [],
  );

  const send = useCallback((message: MeetingMessage) => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => disconnect, [disconnect]);

  return { connect, disconnect, send, connected };
}
