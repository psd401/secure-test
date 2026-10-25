// The test page's entry (D-3): everything the calculator needs, built into
// one plain-JS function body that the page calls only when a student first
// opens the calculator — MathLive's top level touches `navigator` and
// `HTMLElement`, which the JSC harness doesn't have and the page shouldn't
// pay for until it is used. `scripts/build-page.ts` does the wrapping.
import { MathfieldElement } from "mathlive";
import { mountGraphing } from "./ui/calculator";
import { isMode, presetFor } from "./ui/presets";
import { mountStimulus } from "./ui/stimulus";
import { mountGraphAnswer } from "./ui/graphAnswer";

declare var __gcOut: unknown;
__gcOut = { mountGraphing, MathfieldElement, presetFor, isMode, mountStimulus, mountGraphAnswer };
