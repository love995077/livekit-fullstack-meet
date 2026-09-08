import { useCallback, useEffect, useRef } from "react";
import { Tldraw, type Editor, type TLRecord } from "tldraw";
import "tldraw/tldraw.css";

import type { MeetingMessage } from "../lib/useMeetingSocket";
import type { WhiteboardBus } from "../lib/whiteboardBus";

/** How long after the last stroke to publish a full snapshot for late joiners. */
const SNAPSHOT_DELAY_MS = 1500;

type Props = {
  bus: WhiteboardBus;
  send: (message: MeetingMessage) => boolean;
};

/**
 * A tldraw canvas kept in sync over the meeting WebSocket.
 *
 * Local edits go out as incremental diffs for responsiveness; a debounced full
 * snapshot follows so the server holds current state for anyone joining later.
 * Remote edits are applied inside `mergeRemoteChanges`, which tags them as
 * `source: "remote"` so the outgoing listener ignores them and cannot loop.
 */
export default function Whiteboard({ bus, send }: Props) {
  const editorRef = useRef<Editor | null>(null);
  const cleanupRef = useRef<Array<() => void>>([]);
  const snapshotTimer = useRef<number | null>(null);
  const unmountedRef = useRef(false);

  const runCleanups = useCallback(() => {
    const cleanups = cleanupRef.current;
    cleanupRef.current = [];
    for (const fn of cleanups) {
      try {
        fn();
      } catch {
        // A listener that is already detached must not block the rest.
      }
    }
  }, []);

  const sendSnapshot = useCallback(() => {
    snapshotTimer.current = null;
    const editor = editorRef.current;
    if (!editor || unmountedRef.current) return;
    try {
      const records = Object.values(editor.store.serialize("document"));
      send({ type: "whiteboard_update", data: records, snapshot: true });
    } catch (err) {
      console.error("Could not serialize the whiteboard:", err);
    }
  }, [send]);

  const scheduleSnapshot = useCallback(() => {
    if (snapshotTimer.current !== null) {
      window.clearTimeout(snapshotTimer.current);
    }
    snapshotTimer.current = window.setTimeout(sendSnapshot, SNAPSHOT_DELAY_MS);
  }, [sendSnapshot]);

  const applyRemote = useCallback((data: unknown) => {
    const editor = editorRef.current;
    if (!editor || data == null || unmountedRef.current) return;

    try {
      editor.store.mergeRemoteChanges(() => {
        if (Array.isArray(data)) {
          // A full snapshot: every document record in one go.
          editor.store.put(data as TLRecord[]);
          return;
        }
        const diff = (data as { diff?: unknown }).diff;
        if (diff && typeof diff === "object") {
          editor.store.applyDiff(
            diff as Parameters<typeof editor.store.applyDiff>[0],
          );
        }
      });
    } catch (err) {
      // A malformed or schema-mismatched payload must not kill the canvas.
      console.error("Could not apply a remote whiteboard update:", err);
    }
  }, []);

  const handleMount = useCallback(
    (editor: Editor) => {
      // Guard against a second mount (StrictMode, remount) stacking listeners.
      runCleanups();
      editorRef.current = editor;
      unmountedRef.current = false;

      // Outgoing: only local user edits to document records.
      const unlisten = editor.store.listen(
        ({ changes }) => {
          send({ type: "whiteboard_update", data: { diff: changes } });
          scheduleSnapshot();
        },
        { source: "user", scope: "document" },
      );

      // Incoming: subscribing here (not on mount) means buffered updates are
      // replayed only once there is an editor to apply them to.
      const unsubscribe = bus.subscribe(applyRemote);

      cleanupRef.current.push(unlisten, unsubscribe);
    },
    [applyRemote, bus, runCleanups, scheduleSnapshot, send],
  );

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      if (snapshotTimer.current !== null) {
        window.clearTimeout(snapshotTimer.current);
        snapshotTimer.current = null;
      }
      runCleanups();
      editorRef.current = null;
    };
  }, [runCleanups]);

  return (
    <div className="absolute inset-0">
      <Tldraw onMount={handleMount} />
    </div>
  );
}
