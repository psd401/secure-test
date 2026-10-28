"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { FilePicker } from "@/components/app/FilePicker";
import { Label } from "@/components/ui/label";
import { SubmitButton } from "@/components/app/SubmitButton";
import { useImportAction } from "./useImportAction";

/** The flag-off import form: choose the file, Import. */
export function ImportForm() {
  const action = useImportAction();
  return (
    <form action={action} className="mt-8 space-y-5">
      <div className="space-y-2">
        <Label htmlFor="file">Assessment file (.json)</Label>
        <FilePicker id="file" name="file" accept="application/json,.json" label="Choose the .json file…" required />
      </div>
      <div className="flex items-center gap-3">
        <SubmitButton pendingLabel="Importing…">Import</SubmitButton>
        <Button asChild variant="ghost">
          <Link href="/dashboard">Cancel</Link>
        </Button>
      </div>
    </form>
  );
}
