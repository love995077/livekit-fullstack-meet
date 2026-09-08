import { useEffect, useState } from "react";

export type DeviceAvailability = {
  hasCamera: boolean;
  hasMic: boolean;
  /** False until the first probe finishes, so the UI can avoid flashing a warning. */
  checked: boolean;
};

/**
 * Resolves which capture devices exist.
 *
 * `enumerateDevices()` reports device *kinds* without permission being granted
 * (only labels are hidden), so this works before any prompt. If the API is
 * missing or throws, both fall back to false: someone with no usable hardware
 * should still be able to join and watch rather than be blocked at the door.
 */
export async function detectDevices(
  mediaDevices: MediaDevices | undefined,
): Promise<DeviceAvailability> {
  try {
    if (!mediaDevices?.enumerateDevices) {
      throw new Error("mediaDevices unavailable");
    }
    const devices = await mediaDevices.enumerateDevices();
    if (!Array.isArray(devices)) {
      throw new Error("unexpected enumerateDevices result");
    }
    return {
      hasCamera: devices.some((d) => d?.kind === "videoinput"),
      hasMic: devices.some((d) => d?.kind === "audioinput"),
      checked: true,
    };
  } catch {
    return { hasCamera: false, hasMic: false, checked: true };
  }
}

export function useMediaDevices(): DeviceAvailability {
  const [state, setState] = useState<DeviceAvailability>({
    hasCamera: true,
    hasMic: true,
    checked: false,
  });

  useEffect(() => {
    let cancelled = false;

    const probe = async () => {
      const result = await detectDevices(navigator.mediaDevices);
      if (!cancelled) setState(result);
    };

    void probe();

    // Re-probe when hardware is plugged in or removed mid-session.
    const media = navigator.mediaDevices;
    media?.addEventListener?.("devicechange", probe);
    return () => {
      cancelled = true;
      media?.removeEventListener?.("devicechange", probe);
    };
  }, []);

  return state;
}
