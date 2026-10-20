// Calculator configurations (D-6). "state_wa" follows the Desmos
// Washington (WCAP) graphing configuration sheet, SY2026-27, checked
// 2026-10-19 — re-check each school year: degrees by default, and no
// reciprocal or hyperbolic trig, distance, mad / cov / covp (statistics
// beyond the basics), distributions, random or inference (the last three
// this calculator doesn't have at all).

import type { FunctionGroup } from "../engine/builtins";

export interface Preset {
  disabled: FunctionGroup[];
  degrees: boolean;
}

export const PRESETS: Record<string, Preset> = {
  full: { disabled: [], degrees: false },
  state_wa: { disabled: ["reciprocalTrig", "hyperbolic", "advancedStats", "geometry"], degrees: true },
};

export function presetFor(name: string | undefined): Preset {
  return (name && PRESETS[name]) || PRESETS.full!;
}
