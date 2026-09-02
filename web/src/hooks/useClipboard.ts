import { useCallback, useRef, useState } from 'react';

export function useClipboard(resetMs = 1600) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copy = useCallback(
    (text: string) => {
      void navigator.clipboard?.writeText(text).then(() => {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), resetMs);
      });
    },
    [resetMs],
  );

  return { copied, copy };
}
