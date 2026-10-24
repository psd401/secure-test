import { describe, expect, test } from "bun:test";
import { analyzeWithAnswers, NO_ANSWER_ABOVE } from "../src/engine/answers";

const rows = (...latex: string[]) => latex.map((l, i) => ({ id: String(i), latex: l }));
const values = (...latex: string[]) =>
  analyzeWithAnswers(rows(...latex)).map((a) => (a.kind === "value" ? a.value : a.kind === "error" ? a.message : a.kind));

describe("ans — the previous answer", () => {
  test("stands for the row above's value, in the key's form and typed", () => {
    expect(values("3\\times4", "\\operatorname{ans}+1", "ans\\div2")).toEqual([12, 13, 6.5]);
  });

  test("MathLive's re-serialised key form \\operatorname{\\mathrm{ans}} counts as one answer", () => {
    expect(values("3\\times4", "\\operatorname{\\mathrm{ans}}+1", "3+\\operatorname{\\mathrm{ans}}", "\\mathrm{ans}-1")).toEqual([12, 13, 16, 15]);
  });

  test("skips empty rows and rows without a number", () => {
    expect(values("5", "", "2\\operatorname{ans}")).toEqual([5, "empty", 10]);
  });

  test("a negative or tiny answer comes back exactly", () => {
    expect(values("0-7", "\\operatorname{ans}\\times\\operatorname{ans}")).toEqual([-7, 49]);
    expect(values("10^{-9}", "\\operatorname{ans}\\times10^{9}")).toEqual([1e-9, 1]);
  });

  test("with nothing above it says so", () => {
    expect(values("\\operatorname{ans}+1")).toEqual([NO_ANSWER_ABOVE]);
  });

  test("does not touch words that only contain the letters", () => {
    expect(values("\\tan\\left(0\\right)")).toEqual([0]);
  });
});
