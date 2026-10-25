import { describe, expect, test } from "bun:test";
import { formatNumber, formatNumberLatex } from "../src/engine/format";

describe("formatNumber", () => {
  test.each([
    [0, "0"],
    [-0, "0"],
    [7, "7"],
    [-2.5, "-2.5"],
    [0.1 + 0.2, "0.3"],
    [2 / 3, "0.6666666667"],
    [1 / 3, "0.3333333333"],
    [Math.PI, "3.141592654"],
    [123456789, "123456789"],
    [1e11, "100000000000"],
    [1.5e15, "1.5×10^15"],
    [0.000001, "0.000001"],
    [1.25e-7, "1.25×10^-7"],
    [-3e20, "-3×10^20"],
    [NaN, "undefined"],
    [Infinity, "undefined"],
  ])("%p → %s", (x, s) => expect(formatNumber(x)).toBe(s));

  test("LaTeX form", () => {
    expect(formatNumberLatex(1.5e15)).toBe("1.5\\times10^{15}");
    expect(formatNumberLatex(2)).toBe("2");
    expect(formatNumberLatex(NaN)).toBe("\\mathrm{undefined}");
  });
});
