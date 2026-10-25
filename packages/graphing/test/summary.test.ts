import { describe, expect, test } from "bun:test";
import { HIGH_HZ, LOW_HZ, panFor, spokenNumber, summarizeCurve, summarizeGraph, sweep, toneFor } from "../src/engine/summary";
import { Tones } from "../src/ui/audio";

const VIEW = { xmin: -10, xmax: 10, ymin: -10, ymax: 10 };

describe("summarizeCurve", () => {
  test("a parabola: crossings, minimum, y-intercept", () => {
    expect(summarizeCurve("y = x² − 4", (x) => x * x - 4, "y", VIEW)).toBe(
      "y = x² − 4: crosses the x-axis at x = −2 and 2; minimum at (0, −4); crosses the y-axis at y = −4.",
    );
  });

  test("a line", () => {
    expect(summarizeCurve("y = 2x + 1", (x) => 2 * x + 1, "y", VIEW)).toBe(
      "y = 2x + 1: crosses the x-axis at x = −0.5; crosses the y-axis at y = 1.",
    );
  });

  test("through the origin", () => {
    expect(summarizeCurve("y = x", (x) => x, "y", VIEW)).toBe("y = x: crosses the x-axis at x = 0; passes through the origin.");
  });

  test("a maximum, rounded for speech", () => {
    const s = summarizeCurve("y = −(x − √2)² + 3", (x) => -((x - Math.SQRT2) ** 2) + 3, "y", VIEW);
    expect(s).toContain("maximum at (1.414, 3)");
  });

  test("x = f(y) swaps the axes", () => {
    expect(summarizeCurve("x = y² − 1", (y) => y * y - 1, "x", VIEW)).toBe(
      "x = y² − 1: crosses the y-axis at y = −1 and 1; minimum at (−1, 0); crosses the x-axis at x = −1.",
    );
  });

  test("off screen, undefined, flat, monotone", () => {
    expect(summarizeCurve("y = x + 100", (x) => x + 100, "y", VIEW)).toBe("y = x + 100: not in this view.");
    expect(summarizeCurve("y = √(x − 50)", (x) => Math.sqrt(x - 50), "y", VIEW)).toBe("y = √(x − 50): not defined anywhere in this view.");
    expect(summarizeCurve("y = 3", () => 3, "y", VIEW)).toBe("y = 3: crosses the y-axis at y = 3.");
    expect(summarizeCurve("y = eˣ", Math.exp, "y", { xmin: 0.5, xmax: 2, ymin: 0, ymax: 10 })).toBe(
      "y = eˣ: y increases as x increases, with no axis crossings or turning points in this view.",
    );
    expect(summarizeCurve("y = 3", () => 3, "y", { xmin: 1, xmax: 5, ymin: 0, ymax: 10 })).toBe("y = 3: stays at y = 3 across this view.");
  });

  test("many crossings are capped", () => {
    const s = summarizeCurve("y = sin(x)", Math.sin, "y", { xmin: -30, xmax: 30, ymin: -2, ymax: 2 });
    expect(s).toMatch(/and \d+ more/);
  });

  test("no label", () => {
    expect(summarizeCurve("  ", (x) => x + 100, "y", VIEW)).toBe("This curve: not in this view.");
  });
});

describe("summarizeGraph", () => {
  test("the curves, then the view", () => {
    expect(summarizeGraph(["A.", "B."], VIEW)).toBe("A. B. The view shows x from −10 to 10 and y from −10 to 10.");
    expect(summarizeGraph([], { xmin: -1.23456, xmax: 2, ymin: 0, ymax: 1 })).toBe(
      "Nothing is graphed. The view shows x from −1.235 to 2 and y from 0 to 1.",
    );
  });
});

describe("spokenNumber", () => {
  test.each([
    [0.30000000000000004, 1, "0.3"],
    [-2, 1, "−2"],
    [Math.PI, 10, "3.142"],
    [12345.678, 1e4, "12350"],
    [NaN, 1, "undefined"],
  ])("%p → %s", (x, s, out) => expect(spokenNumber(x, s)).toBe(out));
});

describe("pitch and pan", () => {
  test("bottom of the view is the low note, top the high one, an octave per half", () => {
    expect(toneFor(-10, -10, 10)).toBe(LOW_HZ);
    expect(toneFor(10, -10, 10)).toBeCloseTo(HIGH_HZ, 9);
    expect(toneFor(0, -10, 10)).toBeCloseTo(440, 9);
    expect(toneFor(99, -10, 10)).toBeCloseTo(HIGH_HZ, 9);
    expect(toneFor(NaN, -10, 10)).toBeNull();
    expect(toneFor(1, 5, 5)).toBeNull();
  });
  test("pan follows x", () => {
    expect(panFor(-10, -10, 10)).toBe(-1);
    expect(panFor(0, -10, 10)).toBe(0);
    expect(panFor(10, -10, 10)).toBe(1);
  });
  test("sweep: rising notes for a rising line, gaps where it leaves the view or is undefined", () => {
    const up = sweep((x) => x, "y", VIEW, 10);
    expect(up).toHaveLength(10);
    const f = up.map((t) => t.freq!);
    for (let k = 1; k < f.length; k++) expect(f[k]!).toBeGreaterThan(f[k - 1]!);
    expect(up[0]!.pan).toBeLessThan(0);
    expect(up[9]!.pan).toBeGreaterThan(0);
    const gaps = sweep((x) => (x < 0 ? NaN : x * 10), "y", VIEW, 10);
    expect(gaps.slice(0, 5).every((t) => t.freq === null)).toBe(true);
    expect(gaps[5]!.freq).not.toBeNull();
    expect(gaps[9]!.freq).toBeNull();
  });
});

// A recording stand-in for Web Audio: what was scheduled, in order.
function fakeAudio() {
  const log: string[] = [];
  const param = (name: string) => ({
    value: 0,
    setValueAtTime: (v: number) => log.push(`${name}=${Math.round(v)}`),
    linearRampToValueAtTime: (v: number) => log.push(`${name}->${v}`),
    setTargetAtTime: (v: number) => log.push(`${name}~${v}`),
  });
  let made = 0;
  class Ctx {
    currentTime = 0;
    destination = {};
    constructor() {
      made++;
    }
    createOscillator() {
      return {
        type: "",
        frequency: param("f"),
        connect() {},
        start: () => log.push("start"),
        stop: () => log.push("stop"),
        onended: null as null | (() => void),
      };
    }
    createGain() {
      return { gain: param("g"), connect() {} };
    }
    createStereoPanner() {
      return { pan: param("p"), connect() {} };
    }
    resume() {
      return Promise.resolve();
    }
    close() {
      return Promise.resolve();
    }
  }
  return { log, Ctx, made: () => made };
}

describe("Tones", () => {
  const g = globalThis as { AudioContext?: unknown };
  const saved = g.AudioContext;

  test("no Web Audio: silent, and says so", () => {
    delete g.AudioContext;
    const t = new Tones();
    expect(t.note({ freq: 440, pan: 0 })).toBe(false);
    expect(t.available).toBe(false);
    g.AudioContext = saved;
  });

  test("the context is made on the first sound, once", () => {
    const fa = fakeAudio();
    g.AudioContext = fa.Ctx;
    const t = new Tones();
    expect(fa.made()).toBe(0);
    expect(t.note({ freq: 440, pan: 0.5 })).toBe(true);
    expect(t.note({ freq: null, pan: 0 })).toBe(true);
    expect(fa.made()).toBe(1);
    expect(fa.log).toContain("f=440");
    expect(fa.log).toContain("p=1");
    t.close();
    g.AudioContext = saved;
  });

  test("a sweep schedules each note and silences the gaps; stop ends it", () => {
    const fa = fakeAudio();
    g.AudioContext = fa.Ctx;
    const t = new Tones();
    let ended = 0;
    expect(t.sweep([{ freq: 300, pan: -1 }, { freq: null, pan: 0 }, { freq: 600, pan: 1 }], 3, () => ended++)).toBe(true);
    expect(t.busy).toBe(true);
    expect(fa.log.filter((l) => l.startsWith("f="))).toEqual(["f=300", "f=600"]);
    expect(fa.log).toContain("g~0");
    t.stop();
    expect(t.busy).toBe(false);
    expect(ended).toBe(1);
    g.AudioContext = saved;
  });

  test("a throwing Web Audio leaves it silent, not broken", () => {
    g.AudioContext = class {
      constructor() {
        throw new Error("blocked");
      }
    };
    const t = new Tones();
    expect(t.sweep([{ freq: 300, pan: 0 }])).toBe(false);
    expect(t.available).toBe(false);
    g.AudioContext = saved;
  });
});
