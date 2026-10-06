"use client";

import { useState } from "react";

/**
 * Copies a block of text to the clipboard (answer history, docs/answer-history-design.md).
 * The text is also on screen, so a denied clipboard just leaves it to select by hand.
 */
export function CopyTextButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access denied: the text is on screen to select.
    }
  }

  return (
    <button
      type="button"
      onClick={onCopy}
      className="rounded-md border border-border px-2 py-0.5 text-xs hover:bg-accent"
    >
      {copied ? "Copied" : label}
    </button>
  );
}
