"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";

// A visible "Choose a file…" button over a hidden native file input.
// Beta feedback: the bare browser control ("Choose File  no file chosen")
// was easy to miss. The real <input> stays in the DOM so a form submit,
// a `name` / `required` attribute, a ref or a <Label htmlFor> keep working;
// it is out of the tab order so keyboard users land on the button once.
export type FilePickerProps = {
  accept?: string;
  /** Button text; default "Choose a file…". */
  label?: string;
  onFile?: (file: File | null) => void;
  disabled?: boolean;
  id?: string;
  name?: string;
  required?: boolean;
  inputRef?: React.Ref<HTMLInputElement>;
  "aria-label"?: string;
  "aria-describedby"?: string;
};

export function FilePicker({
  accept,
  label = "Choose a file…",
  onFile,
  disabled,
  id,
  name,
  required,
  inputRef,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
}: FilePickerProps) {
  const ownRef = React.useRef<HTMLInputElement | null>(null);
  const [fileName, setFileName] = React.useState<string | null>(null);

  const setRefs = (el: HTMLInputElement | null) => {
    ownRef.current = el;
    if (typeof inputRef === "function") inputRef(el);
    else if (inputRef) inputRef.current = el;
  };

  return (
    <div className="flex min-w-0 items-center gap-3">
      <input
        ref={setRefs}
        id={id}
        name={name}
        type="file"
        accept={accept}
        required={required}
        disabled={disabled}
        tabIndex={-1}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0] ?? null;
          setFileName(f?.name ?? null);
          onFile?.(f);
        }}
      />
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        aria-describedby={ariaDescribedBy}
        onClick={() => ownRef.current?.click()}
      >
        {label}
      </Button>
      <span
        className="min-w-0 truncate text-sm text-muted-foreground"
        aria-live="polite"
      >
        {fileName ?? "No file chosen"}
      </span>
    </div>
  );
}
