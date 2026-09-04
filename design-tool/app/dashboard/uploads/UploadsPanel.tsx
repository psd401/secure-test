"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { ImageIcon } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/app/EmptyState";
import { uploadErrorCopy } from "@/lib/ui/errorCopy";

interface AssetView {
  id: string;
  content_type: string;
  size_bytes: number;
  original_filename: string | null;
  created_at: string;
}

interface Props {
  initialAssets: AssetView[];
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Pull the `error` code out of one of our JSON error bodies, else the status. */
async function errorCode(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    // not JSON
  }
  return `http_${res.status}`;
}

export function UploadsPanel({ initialAssets }: Props) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AssetView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [, startTransition] = useTransition();

  function refresh() {
    startTransition(() => router.refresh());
  }

  async function onUpload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError("missing_file");
      return;
    }
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/uploads/image", { method: "POST", body: form });
      if (!res.ok) {
        setError(await errorCode(res));
        return;
      }
      if (fileRef.current) fileRef.current.value = "";
      refresh();
    } catch {
      setError("network");
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/assets/${pendingDelete.id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) {
        setError(await errorCode(res));
        return;
      }
      refresh();
    } catch {
      setError("network");
    } finally {
      setDeleting(false);
      setPendingDelete(null);
    }
  }

  const copy = error ? uploadErrorCopy(error) : null;

  return (
    <div className="mt-8 space-y-6">
      <form
        onSubmit={onUpload}
        className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed bg-card px-4 py-3"
      >
        <Input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
          aria-label="Image file"
          className="max-w-sm"
        />
        <Button type="submit" disabled={busy}>
          {busy ? "Uploading…" : "Upload"}
        </Button>
      </form>

      {copy ? (
        <Alert variant="destructive">
          <AlertTitle>{copy.message}</AlertTitle>
          {copy.showCode ? (
            <AlertDescription>
              <code className="text-xs">{error}</code>
            </AlertDescription>
          ) : null}
        </Alert>
      ) : null}

      {initialAssets.length === 0 ? (
        <EmptyState
          icon={<ImageIcon />}
          title="No images yet"
          description="Upload one here, then pick it from inside a question."
        />
      ) : (
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {initialAssets.map((a) => (
            <li key={a.id} className="overflow-hidden rounded-lg border bg-card">
              <div className="aspect-square bg-muted">
                {a.content_type.startsWith("image/") ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/assets/${a.id}`}
                    alt={a.original_filename ?? a.id}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-xs">
                    {a.content_type}
                  </div>
                )}
              </div>
              <div className="p-3 text-xs">
                <div className="truncate font-medium" title={a.original_filename ?? ""}>
                  {a.original_filename ?? a.id}
                </div>
                <div className="mt-1 text-muted-foreground">
                  {a.content_type} · {fmtSize(a.size_bytes)}
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <Button asChild variant="link" size="sm" className="h-auto p-0">
                    <a href={`/api/assets/${a.id}`} target="_blank" rel="noreferrer">
                      Open
                    </a>
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setPendingDelete(a)}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {pendingDelete?.original_filename ?? "this image"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Any question that uses it will show a broken image. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
              disabled={deleting}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {deleting ? "Deleting…" : "Delete image"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
