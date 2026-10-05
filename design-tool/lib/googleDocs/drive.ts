import { randomBytes } from "node:crypto";

// Row GD slice 3: the few Drive v3 calls a release makes, with the teacher's
// drive.file token (slice 2). Every call shape here was exercised by the
// slice 0 proof against real Drive on 2026-10-05.

const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const DOC_MIME = "application/vnd.google-apps.document";

/** The token was refused (expired or revoked): the send stops and asks again. */
export class DriveAuthError extends Error {
  constructor() {
    super("drive_auth_needed");
  }
}

/** Any other Drive refusal; `code` is safe to show and log (no token). */
export class DriveError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`drive ${status} ${code}`);
  }
}

export interface DriveClient {
  createFolder(name: string, parentId: string | null): Promise<string>;
  /** True when the folder still exists and is not in the trash. */
  folderUsable(folderId: string): Promise<boolean>;
  uploadDoc(name: string, parentId: string, html: string): Promise<string>;
  shareWriter(fileId: string, email: string): Promise<string>;
}

const RETRY_DELAYS_MS = [500, 1500, 4000];

function retryable(status: number, reason: string): boolean {
  return (
    status === 429 ||
    status >= 500 ||
    (status === 403 && /rateLimitExceeded|userRateLimitExceeded/.test(reason))
  );
}

export function createDriveClient(
  accessToken: string,
  options: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
): DriveClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const auth = { authorization: `Bearer ${accessToken}` };

  async function call(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url, {
        ...init,
        headers: { ...auth, ...(init.headers as Record<string, string> | undefined) },
      });
      if (res.ok) {
        const text = await res.text();
        return text ? (JSON.parse(text) as Record<string, unknown>) : {};
      }
      if (res.status === 401) throw new DriveAuthError();
      let reason = "";
      try {
        const body = (await res.json()) as {
          error?: { errors?: Array<{ reason?: string }>; status?: string };
        };
        reason = body.error?.errors?.[0]?.reason ?? body.error?.status ?? "";
      } catch {
        // a non-JSON error body; the status alone is the code
      }
      if (retryable(res.status, reason) && attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]!);
        continue;
      }
      throw new DriveError(res.status, reason || `http_${res.status}`);
    }
  }

  return {
    async createFolder(name, parentId) {
      const json = await call(`${DRIVE}/files?fields=id`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          mimeType: FOLDER_MIME,
          ...(parentId ? { parents: [parentId] } : {}),
        }),
      });
      return String(json.id);
    },

    async folderUsable(folderId) {
      try {
        const json = await call(`${DRIVE}/files/${encodeURIComponent(folderId)}?fields=id,trashed`, {
          method: "GET",
        });
        return json.trashed !== true;
      } catch (err) {
        if (err instanceof DriveError && err.status === 404) return false;
        throw err;
      }
    },

    async uploadDoc(name, parentId, html) {
      const boundary = `gd${randomBytes(12).toString("hex")}`;
      const body =
        `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n` +
        JSON.stringify({ name, mimeType: DOC_MIME, parents: [parentId] }) +
        `\r\n--${boundary}\r\ncontent-type: text/html; charset=UTF-8\r\n\r\n${html}\r\n--${boundary}--`;
      const json = await call(`${UPLOAD}?uploadType=multipart&fields=id`, {
        method: "POST",
        headers: { "content-type": `multipart/related; boundary=${boundary}` },
        body,
      });
      return String(json.id);
    },

    async shareWriter(fileId, email) {
      // D-11: Drive's own share email tells the student the Doc is there.
      const json = await call(
        `${DRIVE}/files/${encodeURIComponent(fileId)}/permissions?sendNotificationEmail=true&fields=id`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "user", role: "writer", emailAddress: email }),
        },
      );
      return String(json.id);
    },
  };
}

/** The Doc's link, built from its id (no extra call). */
export function docUrl(fileId: string): string {
  return `https://docs.google.com/document/d/${encodeURIComponent(fileId)}/edit`;
}
