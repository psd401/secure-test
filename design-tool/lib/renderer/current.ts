/**
 * The current signed renderer (docs/server-delivered-renderer-design.md D-1,
 * D-2, slice 3 commit 4) — which renderer a delivery bundle should NAME.
 *
 * Storage layout, in the asset bucket through the storage provider (local-fs
 * in dev):
 *
 *   renderers/<manifest sha256>/manifest.json   the canonical, signed bytes
 *   renderers/<manifest sha256>/manifest.sig    DER ECDSA P-256 / SHA-256
 *   renderers/<manifest sha256>/renderer.js
 *   renderers/<manifest sha256>/renderer.css
 *   renderers/current.json                      {"sha256": "<…>", "version": <int>}
 *
 * Everything under a hash prefix is immutable and kept forever: a student who
 * resumes after a deploy is handed the CURRENT renderer, but a shell that
 * already holds an older bundle can still fetch what that bundle names.
 * `deploy.sh` (staging and production, D-12: only when a signature is due)
 * signs (Touch ID), uploads the four files, and writes
 * the pointer LAST.
 *
 * The pointer is trusted for nothing: before naming a renderer this module
 * re-checks the manifest's hash against the pointer, the signature against
 * the compiled-in public keys, the manifest's shape and validity window, and
 * every listed file's hash. A pointer that fails any of it is logged at WARN
 * and the bundle names no renderer. The shell checks the same things again
 * (slice 4); this side's check exists so the server never advertises a
 * renderer the shell will refuse.
 *
 * No database: the renderer route and this lookup must work while Aurora is
 * paused (row AC), so storage is the only source.
 */
import { parseManifest, sha256Hex } from "@secure-test/renderer/manifest";
import { checkManifestUse, verifyManifestSignature } from "@secure-test/renderer/verify";
import { RENDERER_PUBLIC_KEYS } from "@secure-test/renderer/keys";
import { log } from "@/lib/log";
import { getStorageProvider } from "@/lib/storage/provider";
import type { StorageProvider } from "@/lib/storage/types";

export const RENDERER_POINTER_KEY = "renderers/current.json";

/** The four files under a hash prefix, and the content type each is served as. */
export const RENDERER_FILE_TYPES = {
  "manifest.json": "application/json",
  "manifest.sig": "application/octet-stream",
  "renderer.js": "text/javascript",
  "renderer.css": "text/css",
} as const;
export type RendererFileName = keyof typeof RENDERER_FILE_TYPES;

/** The manifest's own files — never listed inside the manifest itself. */
const SIGNED_FILES = new Set<string>(["renderer.js", "renderer.css"]);

export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export function isRendererFileName(name: string): name is RendererFileName {
  return Object.prototype.hasOwnProperty.call(RENDERER_FILE_TYPES, name);
}

export function rendererObjectKey(sha256: string, file: RendererFileName): string {
  if (!SHA256_HEX_RE.test(sha256)) throw new Error("renderer sha256 must be 64 lowercase hex");
  return `renderers/${sha256}/${file}`;
}

/**
 * "Nothing stored there", as each provider says it: ENOENT from local-fs; a
 * 404 from S3 — or a 403, because the task role has no s3:ListBucket and S3
 * then answers a missing key with AccessDenied rather than NoSuchKey.
 */
export function isMissingObject(err: unknown): boolean {
  if ((err as { code?: unknown })?.code === "ENOENT") return true;
  const message = (err as { message?: unknown })?.message;
  return (
    typeof message === "string" &&
    (message.startsWith("storage_s3_error_404") || message.startsWith("storage_s3_error_403"))
  );
}

export type CurrentRenderer = { sha256: string; version: number };

export interface RendererResolverOptions {
  storage?: () => StorageProvider;
  /** Trusted P-256 public keys (PEM). Default: the compiled-in keys. */
  publicKeys?: readonly string[];
  now?: () => Date;
  /** How long a result — a renderer OR a failure — is reused. Default 60 s. */
  ttlMs?: number;
}

export interface RendererResolver {
  current(): Promise<CurrentRenderer | null>;
  /** Drops the cached result. */
  reset(): void;
}

/** Thrown inside resolve() for a pointer that exists but must not be used. */
class InvalidRenderer extends Error {
  constructor(
    readonly reason: string,
    readonly sha256?: string,
  ) {
    super(reason);
  }
}

export function createRendererResolver(options: RendererResolverOptions = {}): RendererResolver {
  const storage = options.storage ?? getStorageProvider;
  const publicKeys = options.publicKeys ?? RENDERER_PUBLIC_KEYS;
  const now = options.now ?? (() => new Date());
  const ttlMs = options.ttlMs ?? 60_000;
  let cached: { at: number; value: Promise<CurrentRenderer | null> } | null = null;

  async function read(provider: StorageProvider, key: string): Promise<Uint8Array | null> {
    try {
      return await provider.get(key);
    } catch (err) {
      if (isMissingObject(err)) return null;
      throw err;
    }
  }

  async function resolve(): Promise<CurrentRenderer | null> {
    const provider = storage();
    const pointerBytes = await read(provider, RENDERER_POINTER_KEY);
    // No pointer = renderer delivery has never been set up here. Not an error.
    if (!pointerBytes) return null;

    let pointer: unknown;
    try {
      pointer = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(pointerBytes));
    } catch {
      throw new InvalidRenderer("pointer_malformed");
    }
    const sha256 = (pointer as { sha256?: unknown })?.sha256;
    const version = (pointer as { version?: unknown })?.version;
    if (typeof sha256 !== "string" || !SHA256_HEX_RE.test(sha256)) {
      throw new InvalidRenderer("pointer_malformed");
    }
    if (!Number.isSafeInteger(version) || (version as number) <= 0) {
      throw new InvalidRenderer("pointer_malformed", sha256);
    }

    const manifestBytes = await read(provider, rendererObjectKey(sha256, "manifest.json"));
    const signature = await read(provider, rendererObjectKey(sha256, "manifest.sig"));
    if (!manifestBytes || !signature) throw new InvalidRenderer("manifest_missing", sha256);
    if (sha256Hex(manifestBytes) !== sha256) {
      throw new InvalidRenderer("manifest_hash_mismatch", sha256);
    }
    if (!verifyManifestSignature(manifestBytes, signature, [...publicKeys])) {
      throw new InvalidRenderer("bad_signature", sha256);
    }
    let manifest: ReturnType<typeof parseManifest>;
    try {
      manifest = parseManifest(manifestBytes);
    } catch {
      throw new InvalidRenderer("manifest_invalid", sha256);
    }
    if (manifest.version !== version) throw new InvalidRenderer("version_mismatch", sha256);
    const use = checkManifestUse(manifest, { now: now(), minVersion: 0 });
    if (!use.ok) throw new InvalidRenderer(use.reason, sha256);

    // Every listed file must be one the route serves, and stored with the
    // listed bytes — so the bundle never names a half-uploaded renderer.
    const names = Object.keys(manifest.files);
    if (names.length === 0 || names.some((n) => !SIGNED_FILES.has(n))) {
      throw new InvalidRenderer("manifest_files_unservable", sha256);
    }
    for (const name of names) {
      const bytes = await read(provider, rendererObjectKey(sha256, name as RendererFileName));
      const entry = manifest.files[name]!;
      if (!bytes || bytes.byteLength !== entry.bytes || sha256Hex(bytes) !== entry.sha256) {
        throw new InvalidRenderer("file_mismatch", sha256);
      }
    }
    return { sha256, version: manifest.version };
  }

  return {
    current() {
      const t = now().getTime();
      if (cached && t - cached.at < ttlMs) return cached.value;
      const value = resolve().catch((err: unknown) => {
        if (err instanceof InvalidRenderer) {
          log.warn("renderer_current_invalid", { reason: err.reason, sha256: err.sha256 });
        } else {
          log.warn("renderer_current_unreadable", {
            message: err instanceof Error ? err.message.slice(0, 500) : String(err),
          });
        }
        return null;
      });
      cached = { at: t, value };
      return value;
    },
    reset() {
      cached = null;
    },
  };
}

let defaultResolver: RendererResolver = createRendererResolver();

/** The renderer a delivery bundle should name now, or null. Cached 60 s. */
export function currentRenderer(): Promise<CurrentRenderer | null> {
  return defaultResolver.current();
}

/** Test seam: swap the module's resolver; returns the previous one. */
export function setRendererResolver(next: RendererResolver): RendererResolver {
  const previous = defaultResolver;
  defaultResolver = next;
  return previous;
}
