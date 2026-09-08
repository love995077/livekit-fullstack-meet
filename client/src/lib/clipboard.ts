import { useCallback, useEffect, useRef, useState } from "react";

/** Copy text, falling back for insecure contexts. Never throws. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // The async clipboard API needs a secure context and user permission.
  }

  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

/**
 * "Copied!" feedback that clears its own timer, so a component unmounting
 * mid-countdown never sets state after teardown.
 */
export function useCopyFeedback(resetAfterMs = 2000) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(
    async (text: string) => {
      const ok = await copyText(text);
      if (!ok) return false;

      setCopied(true);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        setCopied(false);
        timer.current = null;
      }, resetAfterMs);
      return true;
    },
    [resetAfterMs],
  );

  return { copied, copy };
}
