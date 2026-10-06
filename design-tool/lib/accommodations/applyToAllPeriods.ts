import type { SectionAccommodation, SectionAccommodations } from "@/lib/accommodations/sections";

/**
 * U-20 (docs/roadmap-2026-09.md): "Apply to all my periods" on the By class
 * period panel. Copies one period's whole setting (its own list or the
 * test's, plus the tools given to everyone) onto every target period,
 * replacing whatever those periods had. Pure, so the panel's rule is tested
 * without a DOM; the server's validator checks the result like any edit.
 */

/** Periods the button writes to: on a class list now, not the source itself. */
export function applyTargets(
  options: readonly { ps_id: string; on_roster: boolean }[],
  sourcePsId: string,
): string[] {
  return options.filter((o) => o.on_roster && o.ps_id !== sourcePsId).map((o) => o.ps_id);
}

/** Targets whose own, different settings the copy would replace. */
export function overwrittenTargets(
  config: SectionAccommodations,
  sourcePsId: string,
  targets: readonly string[],
): string[] {
  const source = config[sourcePsId];
  return targets.filter((psId) => {
    const target = config[psId];
    return target !== undefined && (!source || !sameSetting(source, target));
  });
}

function sameSetting(a: SectionAccommodation, b: SectionAccommodation): boolean {
  const list = (l: string[] | null) => (l === null ? null : [...l].sort().join("\n"));
  const grants = (g: SectionAccommodation["grants"]) =>
    g
      .map((x) => `${x.tool_id}=${x.value}`)
      .sort()
      .join("\n");
  return list(a.allowed) === list(b.allowed) && grants(a.grants) === grants(b.grants);
}

export function applyToAllPeriods(
  config: SectionAccommodations,
  sourcePsId: string,
  targets: readonly string[],
): SectionAccommodations {
  const source = config[sourcePsId];
  const out: SectionAccommodations = { ...config };
  for (const psId of targets) {
    if (psId === sourcePsId) continue;
    if (!source) delete out[psId];
    else
      out[psId] = {
        allowed: source.allowed === null ? null : [...source.allowed],
        grants: source.grants.map((g) => ({ ...g })),
      };
  }
  return out;
}
