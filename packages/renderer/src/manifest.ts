// The renderer manifest (docs/server-delivered-renderer-design.md D-1, D-2,
// 2.a "Manifest (slice 3)", D-4). Pure functions only — no file or network
// I/O — so the build script, the design tool's route and the verifier share
// one definition.
//
// What a manifest says:
// - `format`     — 1. A shell refuses any other value.
// - `version`    — positive integer, monotonic on `main` (the build uses the
//                  HEAD commit's committer time in unix seconds). The shell
//                  compares it to its compiled-in minimum version (D-2).
// - `commit`     — the 40-hex commit SHA the files were built from; only a
//                  commit with a green `ci` run on `main` is signed.
// - `issued_at` / `not_after` — the 60-day validity window (2.a): a
//                  renderer nobody re-signs expires without an app release.
// - `requires`   — sorted, de-duplicated terms from src/requires.ts (D-4).
// - `files`      — published name → { sha256 (lowercase hex), bytes }.

import { createHash } from "node:crypto";
import { isRequirement, type Requirement } from "./requires";

export const MANIFEST_FORMAT = 1 as const;
export const DEFAULT_VALIDITY_DAYS = 60;

export type RendererManifest = {
  format: 1;
  version: number;
  commit: string;
  issued_at: string;
  not_after: string;
  requires: string[];
  files: Record<string, { sha256: string; bytes: number }>;
};

const COMMIT_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
// Date.prototype.toISOString's shape: always UTC, always `Z`.
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// A published file name: one path segment, no traversal, no case games.
const FILE_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const MANIFEST_KEYS = [
  "commit",
  "files",
  "format",
  "issued_at",
  "not_after",
  "requires",
  "version",
] as const;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type BuildManifestInput = {
  files: Record<string, Uint8Array>;
  version: number;
  commit: string;
  requires: readonly string[];
  issuedAt: Date;
  validityDays?: number;
};

export function buildManifest(input: BuildManifestInput): RendererManifest {
  const { files, version, commit, requires, issuedAt } = input;
  const validityDays = input.validityDays ?? DEFAULT_VALIDITY_DAYS;

  checkVersion(version);
  checkCommit(commit);
  if (!(issuedAt instanceof Date) || Number.isNaN(issuedAt.getTime())) {
    throw new Error("issuedAt must be a valid Date");
  }
  if (!Number.isInteger(validityDays) || validityDays <= 0) {
    throw new Error(`validityDays must be a positive integer, got ${validityDays}`);
  }

  const names = Object.keys(files);
  if (names.length === 0) throw new Error("a manifest needs at least one file");
  const entries: RendererManifest["files"] = {};
  for (const name of names.sort()) {
    checkFileName(name);
    const bytes = files[name]!;
    entries[name] = { sha256: sha256Hex(bytes), bytes: bytes.byteLength };
  }

  return {
    format: MANIFEST_FORMAT,
    version,
    commit,
    issued_at: issuedAt.toISOString(),
    not_after: new Date(issuedAt.getTime() + validityDays * DAY_MS).toISOString(),
    requires: normalizeRequires(requires),
    files: entries,
  };
}

// Canonical byte form — THE bytes that get signed (commit 3) and served, so
// it must never change shape for an equal manifest:
// - UTF-8 JSON with no insignificant whitespace (no spaces, no newline).
// - Object keys sorted recursively by UTF-16 code unit order (JavaScript's
//   default sort); arrays kept in their order (`requires` is already
//   sorted by buildManifest).
// - Strings escaped exactly as JSON.stringify escapes them.
// - Numbers must be safe integers (written in plain decimal); any other
//   number, and any value JSON cannot carry, throws.
// A verifier checks the signature over the received bytes and never needs
// to re-canonicalize; parseManifest still refuses non-canonical bytes so
// one manifest has exactly one byte form.
export function canonicalManifestBytes(m: RendererManifest): Uint8Array {
  return new TextEncoder().encode(canonicalJson(m));
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`canonical JSON carries safe integers only, got ${value}`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(",")}}`;
  }
  throw new Error(`canonical JSON cannot carry a ${typeof value}`);
}

// Validates and returns a manifest from its served bytes. Throws on any
// shape problem, on an unknown key or requirement, and on bytes that are
// not the canonical form of what they parse to.
export function parseManifest(bytes: Uint8Array): RendererManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("manifest is not valid UTF-8 JSON");
  }
  if (!isPlainObject(raw)) throw new Error("manifest must be a JSON object");

  const keys = Object.keys(raw).sort();
  if (
    keys.length !== MANIFEST_KEYS.length ||
    keys.some((k, i) => k !== MANIFEST_KEYS[i])
  ) {
    throw new Error(`manifest keys must be exactly ${MANIFEST_KEYS.join(", ")}`);
  }

  if (raw.format !== MANIFEST_FORMAT) {
    throw new Error(`unsupported manifest format ${String(raw.format)}`);
  }
  checkVersion(raw.version);
  checkCommit(raw.commit);
  const issued = checkTimestamp("issued_at", raw.issued_at);
  const notAfter = checkTimestamp("not_after", raw.not_after);
  if (notAfter <= issued) throw new Error("not_after must be after issued_at");

  if (!Array.isArray(raw.requires)) throw new Error("requires must be an array");
  const requires = raw.requires as unknown[];
  const normalized = normalizeRequires(
    requires.map((r) => {
      if (typeof r !== "string") throw new Error("requires entries must be strings");
      return r;
    }),
  );
  if (normalized.length !== requires.length || normalized.some((r, i) => r !== requires[i])) {
    throw new Error("requires must be sorted and de-duplicated");
  }

  if (!isPlainObject(raw.files)) throw new Error("files must be an object");
  const fileNames = Object.keys(raw.files);
  if (fileNames.length === 0) throw new Error("files must not be empty");
  for (const name of fileNames) {
    checkFileName(name);
    const entry = raw.files[name];
    if (!isPlainObject(entry)) throw new Error(`files.${name} must be an object`);
    const entryKeys = Object.keys(entry).sort();
    if (entryKeys.length !== 2 || entryKeys[0] !== "bytes" || entryKeys[1] !== "sha256") {
      throw new Error(`files.${name} keys must be exactly bytes, sha256`);
    }
    if (typeof entry.sha256 !== "string" || !SHA256_RE.test(entry.sha256)) {
      throw new Error(`files.${name}.sha256 must be 64 lowercase hex characters`);
    }
    if (!Number.isSafeInteger(entry.bytes) || (entry.bytes as number) < 0) {
      throw new Error(`files.${name}.bytes must be a non-negative integer`);
    }
  }

  const manifest = raw as unknown as RendererManifest;
  if (!bytesEqual(canonicalManifestBytes(manifest), bytes)) {
    throw new Error("manifest bytes are not in canonical form");
  }
  return manifest;
}

function normalizeRequires(requires: readonly string[]): Requirement[] {
  for (const r of requires) {
    if (!isRequirement(r)) throw new Error(`unknown requirement "${r}"`);
  }
  return [...new Set(requires as readonly Requirement[])].sort();
}

function checkVersion(v: unknown): asserts v is number {
  if (!Number.isSafeInteger(v) || (v as number) <= 0) {
    throw new Error(`version must be a positive integer, got ${String(v)}`);
  }
}

function checkCommit(c: unknown): asserts c is string {
  if (typeof c !== "string" || !COMMIT_RE.test(c)) {
    throw new Error("commit must be a 40-character lowercase hex SHA");
  }
}

function checkFileName(name: string): void {
  if (!FILE_NAME_RE.test(name) || name.includes("..")) {
    throw new Error(`file name "${name}" is not allowed`);
  }
}

function checkTimestamp(field: string, v: unknown): number {
  if (typeof v !== "string" || !TIMESTAMP_RE.test(v)) {
    throw new Error(`${field} must be an ISO-8601 UTC timestamp ending in Z`);
  }
  const t = Date.parse(v);
  if (Number.isNaN(t) || new Date(t).toISOString() !== v) {
    throw new Error(`${field} is not a real date`);
  }
  return t;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}
