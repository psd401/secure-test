// Calculator configurations (D-6), per mode.
//
// "state_wa" follows the Desmos Washington (WCAP) configuration sheet,
// SY2026-27, checked 2026-10-19 — re-check each school year:
// - graphing: degrees by default; no reciprocal or hyperbolic trig,
//   distance, or statistics beyond the basics (mad / cov / covp);
//   distributions, random and inference this calculator doesn't have.
// - scientific: the same function limits, and no function definitions.
// - four-function: a fraction key in place of √ (OSPI's paper policy says
//   √ and % — unverified which is current; the sheet is followed).

import type { FunctionGroup } from "../engine/builtins";
import type { Page } from "./keypad";

export type Mode = "graphing" | "scientific" | "four_function";

export interface Preset {
  disabled: FunctionGroup[];
  degrees: boolean;
  /** Function definitions (f(x)=…) allowed. */
  functions: boolean;
  /** Keypad pages, in tab order. */
  pages: Page[];
  /** Whether the four-function keypad shows √ (else a fraction key only). */
  sqrtKey: boolean;
}

const ALL_GROUPS: FunctionGroup[] = [
  "trig",
  "inverseTrig",
  "reciprocalTrig",
  "hyperbolic",
  "log",
  "rounding",
  "numberTheory",
  "stats",
  "advancedStats",
  "combinatorics",
  "geometry",
];
const WA_LIMITS: FunctionGroup[] = ["reciprocalTrig", "hyperbolic", "advancedStats", "geometry"];

export const PRESETS: Record<Mode, Record<string, Preset>> = {
  graphing: {
    full: { disabled: [], degrees: false, functions: true, pages: ["main", "alpha", "functions"], sqrtKey: true },
    state_wa: { disabled: WA_LIMITS, degrees: true, functions: true, pages: ["main", "alpha", "functions"], sqrtKey: true },
  },
  scientific: {
    full: { disabled: [], degrees: false, functions: true, pages: ["main", "alpha", "functions"], sqrtKey: true },
    state_wa: { disabled: WA_LIMITS, degrees: true, functions: false, pages: ["main", "alpha", "functions"], sqrtKey: true },
  },
  four_function: {
    full: { disabled: ALL_GROUPS, degrees: false, functions: false, pages: ["four"], sqrtKey: true },
    // No √ on the state test's four-function calculator: "misc" (√, |x|,
    // sign) goes too, and typing sqrt is refused like any other function.
    state_wa: { disabled: [...ALL_GROUPS, "misc"], degrees: false, functions: false, pages: ["four"], sqrtKey: false },
  },
};

export function presetFor(name: string | undefined, mode: Mode = "graphing"): Preset {
  const byMode = PRESETS[mode] ?? PRESETS.graphing;
  return (name && byMode[name]) || byMode.full!;
}

export function isMode(m: unknown): m is Mode {
  return m === "graphing" || m === "scientific" || m === "four_function";
}
