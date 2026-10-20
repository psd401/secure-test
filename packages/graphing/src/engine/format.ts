// Numbers as the calculator shows them: up to ten significant digits,
// float noise trimmed, scientific notation outside 10⁻⁶ … 10¹², and
// "undefined" for anything that is not a finite real.

const SIG = 10;

/** Plain text: "0.3333333333", "1.5×10^15", "−2", "undefined". */
export function formatNumber(x: number): string {
  const parts = formatParts(x);
  if (parts === null) return "undefined";
  const [mant, exp] = parts;
  return exp === null ? mant : `${mant}×10^${exp}`;
}

/** LaTeX for the same: "1.5\\times10^{15}". */
export function formatNumberLatex(x: number): string {
  const parts = formatParts(x);
  if (parts === null) return "\\mathrm{undefined}";
  const [mant, exp] = parts;
  return exp === null ? mant : `${mant}\\times10^{${exp}}`;
}

function formatParts(x: number): [string, string | null] | null {
  if (!Number.isFinite(x)) return null;
  if (x === 0 || Object.is(x, -0)) return ["0", null];
  const abs = Math.abs(x);
  const sign = x < 0 ? "-" : "";
  // Whole numbers below 10¹² print in full: 2³⁵ is 34359738368.
  if (Number.isInteger(abs) && abs < 1e12) return [sign + String(abs), null];
  // Range by the value as it will print: 999999999999.9 rounds up to 10¹².
  const shown = Number(abs.toPrecision(SIG));
  if (shown >= 1e-6 && shown < 1e12) {
    // toPrecision then trim: 0.1+0.2 → 0.3, 2/3 → 0.6666666667.
    let s = abs.toPrecision(SIG);
    if (s.includes("e")) s = Number(s).toString();
    if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
    return [sign + s, null];
  }
  const [m, e] = abs.toExponential(SIG - 1).split("e") as [string, string];
  const mant = m.includes(".") ? m.replace(/0+$/, "").replace(/\.$/, "") : m;
  return [sign + mant, String(Number(e))];
}
