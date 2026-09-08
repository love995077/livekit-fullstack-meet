/**
 * Hands remote whiteboard payloads from the meeting socket to the whiteboard
 * component. Updates that arrive before the board is open (the snapshot sent on
 * connect, for instance) are buffered and replayed once it subscribes.
 */
export type WhiteboardBus = {
  publish: (data: unknown) => void;
  subscribe: (handler: (data: unknown) => void) => () => void;
  reset: () => void;
};

export function createWhiteboardBus(): WhiteboardBus {
  let handler: ((data: unknown) => void) | null = null;
  let buffer: unknown[] = [];

  return {
    publish(data) {
      if (handler) {
        handler(data);
      } else {
        buffer.push(data);
      }
    },
    subscribe(next) {
      handler = next;
      const pending = buffer;
      buffer = [];
      pending.forEach(next);
      return () => {
        if (handler === next) handler = null;
      };
    },
    /** End of meeting: drop buffered state and any still-attached subscriber. */
    reset() {
      buffer = [];
      handler = null;
    },
  };
}
