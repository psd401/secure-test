import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTENT_OPTIONS } from "../lib/googleDocs/sendDialog";
import { PACKET_CONTENT_KEYS } from "../lib/reporting/workPacket";

// FR slice 6 (docs/feedback-release-design.md): /help.html names the boxes the
// Doc dialog and the packet toolbar show (D-7: both read CONTENT_OPTIONS), so
// a box renamed or added in code without the help page fails here instead of
// leaving teachers a stale list.
const page = readFileSync(join(import.meta.dir, "..", "public", "help.html"), "utf8")
  .replace(/&rsquo;/g, "'")
  .replace(/&amp;/g, "&");

/** The help page's `<li>` that starts with the given button name. */
function helpStep(button: string): string {
  const start = page.indexOf(`<li><b class="ui">${button}</b>`);
  expect(start).toBeGreaterThan(-1);
  return page.slice(start, page.indexOf("</li>", start));
}

describe("/help.html names the feedback release boxes (FR D-7)", () => {
  test("Send to Google Docs lists every Doc box, by its dialog label", () => {
    const step = helpStep("Send to Google Docs");
    for (const { label } of CONTENT_OPTIONS) expect(step).toContain(`<b class="ui">${label}</b>`);
    expect(step).toContain("short answers"); // D-5
  });

  test("Print student work lists every packet box and Teacher copy", () => {
    const step = helpStep("Print student work");
    const packet = CONTENT_OPTIONS.filter((o) =>
      (PACKET_CONTENT_KEYS as readonly string[]).includes(o.key),
    );
    expect(packet.length).toBe(PACKET_CONTENT_KEYS.length);
    for (const { label } of packet) expect(step).toContain(`<b class="ui">${label}</b>`);
    expect(step).toContain(`<b class="ui">Teacher copy</b>`); // D-16
  });

  test("the scoring topic says where teachers type their own feedback (D-4)", () => {
    const start = page.indexOf('id="score"');
    const topic = page.slice(start, page.indexOf("</section>", start));
    expect(topic).toContain(`<b class="ui">Teacher feedback</b>`);
    expect(topic).toContain(`<b class="ui">Teacher feedback (overall)</b>`);
    expect(topic).toContain(`<b class="ui">Save feedback</b>`);
  });
});
