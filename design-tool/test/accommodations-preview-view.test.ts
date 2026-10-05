// U-16 slice 2: the words of the "Who gets what" preview.
import { describe, expect, test } from "bun:test";
import { alsoOnRecordLine, othersLine, previewRows, toolSetting } from "../lib/accommodations/previewView";
import type { AccommodationsPreview, PreviewStudent } from "../lib/accommodations/preview";

const student = (over: Partial<PreviewStudent>): PreviewStudent => ({
  student_id: "s",
  name: "Ada",
  ssid: null,
  roster_ps_id: null,
  tools: [],
  removed_by_exception: [],
  not_allowed: [],
  ...over,
});

describe("Who gets what — words", () => {
  test("a plain On reads as the tool's name; a setting is shown", () => {
    expect(toolSetting("spell_check", "On")).toBe("Spell Check");
    expect(toolSetting("color_contrast", "Black on Rose")).toBe("Color Contrast: Black on Rose");
  });

  test("a row carries tags, a switched-off line and a not-allowed line", () => {
    const [row] = previewRows({
      others_count: 3,
      students: [
        student({
          tools: [{ tool_id: "spell_check", value: "On", exception: true, construct_altering: true, from_record_of: null, from_section: false }],
          removed_by_exception: ["zoom"],
          not_allowed: [{ tool_id: "color_contrast", value: "Black on Rose" }],
        }),
      ],
    });
    expect(row!.heading).toBe("Ada");
    expect(row!.tools).toEqual([{ text: "Spell Check", exception: true, constructAltering: true, fromRecordOf: null }]);
    expect(row!.removedLine).toBe("Switched off for this test: Zoom (in-app)");
    expect(row!.notAllowedLine).toBe("On their record, not allowed here: Color Contrast: Black on Rose");
  });

  test("a student who gets none but has a reason is listed; a hidden tool is no reason", () => {
    const rows = previewRows({
      others_count: null,
      students: [
        student({ student_id: "a", not_allowed: [{ tool_id: "spell_check", value: "On" }] }),
        student({ student_id: "b", name: "Ben", not_allowed: [{ tool_id: "desmos_calculator", value: "On" }] }),
      ],
    });
    expect(rows.map((r) => r.studentId)).toEqual(["a"]);
    expect(rows[0]!.tools).toEqual([]);
  });

  test("the line under the list", () => {
    const p = (n: number | null): AccommodationsPreview => ({ students: [], others_count: n });
    expect(othersLine(p(null))).toBe("Everyone else gets none.");
    expect(othersLine(p(1))).toBe("1 other student on your class lists gets none.");
    expect(othersLine(p(27))).toBe("27 other students on your class lists get none.");
  });

  test("U-17: a co-teacher's tool and record are named by the address's local part", () => {
    const [row] = previewRows({
      others_count: 0,
      students: [
        student({
          tools: [{ tool_id: "zoom", value: "2X", exception: false, construct_altering: false, from_record_of: "teacher.one@psd401.net", from_section: false }],
        }),
      ],
    });
    expect(row!.tools[0]!.fromRecordOf).toBe("teacher.one");
    expect(
      alsoOnRecordLine({
        email: "teacher.one@psd401.net",
        tools: [
          { tool_id: "spell_check", value: "On" },
          { tool_id: "zoom", value: "2X" },
        ],
      }),
    ).toBe("Also on teacher.one's record: Spell Check, Zoom (in-app): 2X");
  });
});
