"use client";

import { useRouter } from "next/navigation";
import { importFileDestination } from "@/lib/preview/importFile";

/**
 * The import form's action, run in the browser: post the file to the import
 * route and go where `importFileDestination` says. A client action rather
 * than a server action so the file is not held to Next's 1 MB server-action
 * body cap; `useFormStatus` still sees it pending.
 */
export function useImportAction(): (form: FormData) => Promise<void> {
  const router = useRouter();
  return async (form) => {
    router.push(await importFileDestination(form));
  };
}
