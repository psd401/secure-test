import { describe, expect, test } from "bun:test";
import { applyTargets, applyToAllPeriods, overwrittenTargets } from "../lib/accommodations/applyToAllPeriods";
import type { SectionAccommodations } from "../lib/accommodations/sections";

const options = [
  { ps_id: "5001", on_roster: true },
  { ps_id: "5002", on_roster: true },
  { ps_id: "5003", on_roster: true },
  { ps_id: "5999", on_roster: false },
];

describe("U-20 apply to all my periods", () => {
  test("targets every period on a class list except the source", () => {
    expect(applyTargets(options, "5001")).toEqual(["5002", "5003"]);
  });

  test("copies the whole setting (own list + grants) and replaces the targets'", () => {
    const config: SectionAccommodations = {
      "5001": { allowed: ["spell_check", "zoom"], grants: [{ tool_id: "spell_check", value: "On" }] },
      "5002": { allowed: null, grants: [{ tool_id: "zoom", value: "2X" }] },
      "5999": { allowed: [], grants: [] },
    };
    const out = applyToAllPeriods(config, "5001", applyTargets(options, "5001"));
    expect(out["5002"]).toEqual(config["5001"]);
    expect(out["5003"]).toEqual(config["5001"]);
    expect(out["5999"]).toEqual({ allowed: [], grants: [] }); // off-roster period untouched
    expect(out["5002"]!.grants).not.toBe(config["5001"]!.grants); // copies, not shared arrays
    expect(config["5002"]).toEqual({ allowed: null, grants: [{ tool_id: "zoom", value: "2X" }] }); // input unchanged
  });

  test("test's list + grants copies as allowed: null", () => {
    const config: SectionAccommodations = { "5001": { allowed: null, grants: [{ tool_id: "spell_check", value: "On" }] } };
    expect(applyToAllPeriods(config, "5001", ["5002"])["5002"]).toEqual({
      allowed: null,
      grants: [{ tool_id: "spell_check", value: "On" }],
    });
  });

  test("names only targets whose different settings would be replaced", () => {
    const config: SectionAccommodations = {
      "5001": { allowed: ["zoom", "spell_check"], grants: [{ tool_id: "spell_check", value: "On" }] },
      "5002": { allowed: ["spell_check", "zoom"], grants: [{ tool_id: "spell_check", value: "On" }] }, // same, reordered
      "5003": { allowed: null, grants: [] },
    };
    expect(overwrittenTargets(config, "5001", ["5002", "5003"])).toEqual(["5003"]);
    expect(overwrittenTargets(config, "5001", ["5002"])).toEqual([]);
  });
});
