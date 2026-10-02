import type { ConverseDocumentFormat } from "@/lib/ai/bedrockConverse";

// The file types a teacher may hand an AI surface as source material, shared
// by the rubric upload (docs/rubric-upload-design.md, D-1) and batch item
// generation (docs/batch-item-generation-design.md, D-4: "size cap as the
// rubric upload").

/** A rubric is one to three pages; 25 MiB is the item importer's cap. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * D-1: PDF and DOCX ride to the model as Converse document blocks (the
 * table layout is what makes them readable); Markdown and plain text are
 * already structured, so they are decoded and sent as text — which also
 * lets the guardrail's input stage run on them.
 */
export const ALLOWED_UPLOADS: {
  ext: string;
  format: ConverseDocumentFormat;
  mimes: string[];
  as: "document" | "text";
}[] = [
  { ext: "pdf", format: "pdf", mimes: ["application/pdf"], as: "document" },
  {
    ext: "docx",
    format: "docx",
    mimes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    as: "document",
  },
  { ext: "md", format: "md", mimes: ["text/markdown", "text/x-markdown"], as: "text" },
  { ext: "txt", format: "txt", mimes: ["text/plain"], as: "text" },
];

export function allowedUploadFor(file: File): (typeof ALLOWED_UPLOADS)[number] | null {
  const ext = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "";
  const byExt = ALLOWED_UPLOADS.find((a) => a.ext === ext);
  if (byExt) return byExt;
  // A browser that sends no filename extension still sends a type.
  const mime = (file.type || "").split(";")[0]!.trim().toLowerCase();
  return ALLOWED_UPLOADS.find((a) => a.mimes.includes(mime)) ?? null;
}
