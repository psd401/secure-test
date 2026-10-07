import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChangedFromPdf } from "../app/dashboard/[id]/ChangedFromPdf";

describe("<ChangedFromPdf> (beta feedback 2026-10-07)", () => {
  test("nothing when nothing changed", () => {
    expect(renderToStaticMarkup(<ChangedFromPdf changes={[]} />)).toBe("");
  });

  test("a blue badge with the count; each change printed → now · reason", () => {
    const html = renderToStaticMarkup(
      <ChangedFromPdf
        changes={[
          { original: "(Underline the significant digits.)", changed_to: "", reason: "cannot underline on screen" },
          { original: "ˍ", changed_to: "−", reason: "unclear in the PDF" },
        ]}
      />,
    );
    expect(html).toContain("bg-info");
    expect(html).toContain("text-info-foreground");
    expect(html).toContain("Changed from the PDF (2)");
    expect(html).toContain("“(Underline the significant digits.)”");
    expect(html).toContain("<em>removed</em>");
    expect(html).toContain("“−”");
    expect(html).toContain(" · unclear in the PDF");
  });
});
