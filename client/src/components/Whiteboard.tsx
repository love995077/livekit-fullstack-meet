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

  const sendSnapshot = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const records = Object.values(editor.store.serialize("document"));
    send({ type: "whiteboard_update", data: records, snapshot: true });
  }, [send]);

  const scheduleSnapshot = useCallback(() => {
    if (snapshotTimer.current !== null) {
      window.clearTimeout(snapshotTimer.current);
    }
    snapshotTimer.current = window.setTimeout(sendSnapshot, SNAPSHOT_DELAY_MS);
  }, [sendSnapshot]);

  const applyRemote = useCallback((data: unknown) => {
    const editor = editorRef.current;
    if (!editor || data == null) return;

    editor.store.mergeRemoteChanges(() => {
      if (Array.isArray(data)) {
        // A full snapshot: every document record in one go.
        editor.store.put(data as TLRecord[]);
        return;
      }
      const diff = (data as { diff?: unknown }).diff;
      if (diff && typeof diff === "object") {
        editor.store.applyDiff(diff as Parameters<typeof editor.store.applyDiff>[0]);
      }
    });
  }, []);

  const handleMount = useCallback(
    (editor: Editor) => {
      editorRef.current = editor;

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
    [applyRemote, bus, scheduleSnapshot, send],
  );

  useEffect(() => {
    const cleanups = cleanupRef.current;
    return () => {
      if (snapshotTimer.current !== null) {
        window.clearTimeout(snapshotTimer.current);
      }
      cleanups.forEach((fn) => fn());
      cleanups.length = 0;
      editorRef.current = null;
    };
  }, []);

  return (
    <div className="absolute inset-0">
      <Tldraw onMount={handleMount} />
    </div>
  );
}
