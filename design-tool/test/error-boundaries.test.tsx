// Batch 3 slice 2: the three error surfaces all show the same "ref", because
// that string is the only thing a teacher can hand IT that finds the row.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import RootError from "../app/error";
import GlobalError from "../app/global-error";
import { misconfiguredPage } from "../proxy";

const noop = () => {};

describe("app/error.tsx (root boundary)", () => {
  test("renders the ref when the error has a digest", () => {
    const err = Object.assign(new Error("boom"), { digest: "3141592653" });
    const html = renderToStaticMarkup(<RootError error={err} reset={noop} />);
    expect(html).toContain("ref 3141592653");
    expect(html).toContain("Try again");
    // The message itself is a server-side detail; the screen must not leak it.
    expect(html).not.toContain("boom");
  });

  test("omits the ref line entirely when there is no digest", () => {
    const html = renderToStaticMarkup(<RootError error={new Error("boom")} reset={noop} />);
    expect(html).not.toContain("<code");
    expect(html).toContain("Try again");
  });
});

describe("app/global-error.tsx", () => {
  test("renders its own document and the same ref", () => {
    const err = Object.assign(new Error("layout blew up"), { digest: "2718281828" });
    const html = renderToStaticMarkup(<GlobalError error={err} reset={noop} />);
    expect(html).toContain("<html");
    expect(html).toContain("<body");
    expect(html).toContain("ref 2718281828");
    expect(html).not.toContain("layout blew up");
  });
});

describe("proxy's misconfigured page", () => {
  test("is HTML with the ref, not the text/plain line it replaced", () => {
    const html = misconfiguredPage("req-42");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("ref req-42");
    expect(html).not.toContain("server misconfigured");
  });
});
