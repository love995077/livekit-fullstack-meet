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
};

/**
 * A single meeting WebSocket, opened on demand and kept for the whole session:
 * it carries the waiting-room handshake first and whiteboard updates afterwards.
 */
export function useMeetingSocket({ onMessage }: Options) {
  const socketRef = useRef<WebSocket | null>(null);
  const handlerRef = useRef(onMessage);
  const [connected, setConnected] = useState(false);

  // Keep the latest handler without tearing down the socket on every render.
  useEffect(() => {
    handlerRef.current = onMessage;
  }, [onMessage]);

  const disconnect = useCallback(() => {
    const socket = socketRef.current;
    socketRef.current = null;
    setConnected(false);
    if (socket && socket.readyState <= WebSocket.OPEN) {
      socket.close();
    }
  }, []);

  const connect = useCallback(
    (room: string, name: string, role: SocketRole) =>
      new Promise<WebSocket>((resolve, reject) => {
        // Reconnecting with a different role/room replaces the old socket.
        if (socketRef.current) {
          socketRef.current.onclose = null;
          socketRef.current.close();
        }

        const socket = new WebSocket(meetingSocketUrl(room, name, role));
        socketRef.current = socket;

        socket.onopen = () => {
          setConnected(true);
          resolve(socket);
        };
        socket.onerror = () => {
          reject(new Error("Could not reach the meeting server."));
        };
        socket.onclose = () => {
          if (socketRef.current === socket) {
            socketRef.current = null;
            setConnected(false);
          }
        };
        socket.onmessage = (event) => {
          try {
            handlerRef.current(JSON.parse(event.data) as MeetingMessage);
          } catch {
            // Ignore frames that are not JSON.
          }
        };
      }),
    [],
  );

  const send = useCallback((message: MeetingMessage) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
      return true;
    }
    return false;
  }, []);

  useEffect(() => disconnect, [disconnect]);

  return { connect, disconnect, send, connected };
}
