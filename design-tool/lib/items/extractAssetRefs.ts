// Walks one or more text strings and returns the set of asset UUIDs they
// reference via `![alt](asset:<uuid>)` markdown-flavored syntax. The
// caller uses the resulting set to do a single owner-scoped DB lookup
// before passing the resolved metadata to renderItemContent.

const REF_RE =
  /!\[[^\]]*\]\(asset:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/gi;

export function extractAssetRefs(text: string): string[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const out: string[] = [];
  let match: RegExpExecArray | null;
  REF_RE.lastIndex = 0;
  while ((match = REF_RE.exec(text)) !== null) {
    out.push(match[1]!.toLowerCase());
  }
  return out;
}

export function extractAssetRefsFromMany(texts: readonly string[]): string[] {
  const set = new Set<string>();
  for (const t of texts) {
    for (const id of extractAssetRefs(t)) set.add(id);
  }
  return [...set];
}

const UUID_ONLY_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A single `asset:<uuid>` occurrence (non-global) — for pickers that parse
// the uuid back out of the markdown ImagePicker inserts. The strict
// per-group shape, NOT a loose [0-9a-f-]{36} run; every asset-ref pattern
// in the app lives in this file.
export const ASSET_REF_ONE_RE =
  /asset:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

// Asset ids referenced from items.config (slice 49 hotspot image, slice 50
// drawing reference) — the single source for which config fields carry
// asset refs, shared by export bundling and preview resolution. Non-uuid
// values are DROPPED here: the wire schema is permissive (min(1) string),
// so an imported or forged ref that isn't uuid-shaped must never reach an
// inArray(...) against the uuid assets.id column — Postgres rejects the
// cast (22P02) and the whole preview/export 500s.
export function assetIdsFromItemConfig(
  config:
    | { image_asset_id?: string | null; prompt_asset_id?: string | null }
    | null
    | undefined,
): string[] {
  const out: string[] = [];
  for (const id of [config?.image_asset_id, config?.prompt_asset_id]) {
    if (typeof id === "string" && UUID_ONLY_RE.test(id)) {
      out.push(id.toLowerCase());
    }
  }
  return out;
}
