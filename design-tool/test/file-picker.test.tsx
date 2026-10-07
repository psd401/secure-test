import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FilePicker } from "../components/app/FilePicker";

describe("<FilePicker>", () => {
  test("a visible button over a hidden input that keeps name / required / accept", () => {
    const html = renderToStaticMarkup(
      <FilePicker id="f" name="file" accept=".pdf" required label="Choose a PDF…" />,
    );
    expect(html).toContain('type="file"');
    expect(html).toContain('name="file"');
    expect(html).toContain('accept=".pdf"');
    expect(html).toContain("required");
    expect(html).toContain('class="sr-only"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>Choose a PDF…<\/button>/);
    expect(html).toContain("No file chosen");
  });

  test("disabled reaches both the input and the button", () => {
    const html = renderToStaticMarkup(<FilePicker disabled />);
    expect(html.match(/disabled=""/g)?.length).toBe(2);
    expect(html).toContain("Choose a file…");
  });
});
