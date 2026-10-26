// Editor redesign Phase 5 slice B (ADR 0019 §1–§4): the interactive
// preview's frame document — the CSP and its hashes, the copies of client
// bytes it inlines (drift checks), the bootstrap run against the student's
// real renderer in the client harness's DOM shim, and the route's gating.
//
// What this cannot test (no browser here, ADR 0013): that a browser actually
// enforces the sandbox and the hash pins. Those are hand-check rows.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import { setNewAuthoring } from "../lib/authoring/flag";
import { KATEX_JS } from "../lib/preview/katex.min.js";
import { KATEX_CSS } from "../lib/preview/katex.min.css";
import { PAGE_BASE_STYLES } from "../lib/preview/interactive/pageShell.generated";
import { PREVIEW_BOOTSTRAP_JS, PREVIEW_PROTOCOL, RENDERER_SOURCE_ID } from "../lib/preview/interactive/bootstrap";
import {
  brandFontsCss,
  buildPreviewShell,
  inlineKatexFonts,
  previewCsp,
  scriptHashSource,
} from "../lib/preview/interactive/shell";
import { buildPreviewBundle, createPreviewSealer } from "../lib/preview/interactive/bundle";
import { parseFrameMessage } from "../lib/preview/interactive/protocol";
import { defaultItemFor, type ItemView } from "../app/dashboard/[id]/editorModel";
import { extractBaseStyles, renderModule } from "../scripts/vendor-page-shell";
import {
  CLIENT_SOURCES,
  collectLiterals,
  extractRenderer,
  resolveLiteral,
} from "../../packages/renderer/scripts/extract-swift";
import { staffPrincipal, type TestPrincipal } from "./helpers/roster";

const REPO = join(import.meta.dir, "..", "..");
const read = (file: string) => ({ file, source: readFileSync(join(REPO, file), "utf8") });
const RENDERER = extractRenderer(CLIENT_SOURCES.map(read));

const PARTS = {
  rendererJs: "var r = 1;",
  rendererCss: ".item{}",
  katexJs: "var katex = {};",
  katexCss: ".katex{}",
  baseCss: ":root{}",
  fontsCss: "",
};

function between(html: string, open: string, close: string): string {
  const start = html.indexOf(open);
  if (start < 0) throw new Error(`missing ${open}`);
  const from = start + open.length;
  return html.slice(from, html.indexOf(close, from));
}

describe("the frame document and its CSP", () => {
  test("a hash source is base64 SHA-256 of the script's UTF-8 text", () => {
    expect(scriptHashSource("")).toBe("'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='");
    expect(scriptHashSource("é")).toBe(`'sha256-${createHash("sha256").update("é", "utf8").digest("base64")}'`);
  });

  test("exactly three scripts are pinned — bootstrap, KaTeX, renderer — each by the text served", () => {
    const shell = buildPreviewShell({ ...PARTS, rendererJs: RENDERER.js, rendererCss: RENDERER.css, katexJs: KATEX_JS });
    const servedRenderer = between(shell.html, `<script type="text/plain" id="${RENDERER_SOURCE_ID}">`, "</script>");
    expect(servedRenderer).toBe(RENDERER.js);
    const servedKatex = between(shell.html, "<script>", "</script>");
    expect(servedKatex).toBe(KATEX_JS);
    const servedBootstrap = between(shell.html.slice(shell.html.indexOf(`id="${RENDERER_SOURCE_ID}"`)), "</script>\n<script>", "</script>");
    expect(servedBootstrap).toBe(PREVIEW_BOOTSTRAP_JS);
    expect(shell.scriptHashes).toEqual([
      scriptHashSource(PREVIEW_BOOTSTRAP_JS),
      scriptHashSource(KATEX_JS),
      scriptHashSource(RENDERER.js),
    ]);
    const scriptSrc = shell.csp.split("; ").find((d) => d.startsWith("script-src "))!;
    expect(scriptSrc.split(" ").slice(1)).toEqual(shell.scriptHashes);
  });

  test("the header policy: no network, no unsafe script, framed by the design tool only, sandboxed", () => {
    const csp = previewCsp(["'sha256-a'"], { header: true }).split("; ");
    expect(csp).toEqual([
      "default-src 'none'",
      "script-src 'sha256-a'",
      "style-src 'unsafe-inline'",
      "img-src data:",
      "font-src data:",
      "connect-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      "frame-ancestors 'self'",
      "sandbox allow-scripts",
    ]);
    expect(csp.join(";")).not.toContain("unsafe-eval");
    expect(csp.find((d) => d.startsWith("script-src"))).not.toContain("unsafe-inline");
  });

  test("the <meta> repeats the policy minus the header-only directives", () => {
    const shell = buildPreviewShell(PARTS);
    const meta = between(shell.html, '<meta http-equiv="Content-Security-Policy" content="', '">');
    expect(meta).toBe(previewCsp(shell.scriptHashes, { header: false }));
    expect(meta).not.toContain("frame-ancestors");
    expect(meta).not.toContain("sandbox");
  });

  test("the document is the client page's skeleton and carries no content", () => {
    const html = buildPreviewShell(PARTS).html;
    expect(html).toContain("<h1></h1>\n<div id=\"items\"></div>");
    // Styles in PageShell.document's order: fonts, base, KaTeX, renderer.
    const order = [":root{}", ".katex{}", ".item{}"].map((css) => html.indexOf(`<style>${css}</style>`));
    expect(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1]!))).toBe(true);
  });

  test("text that could close its element early is refused, not served", () => {
    expect(() => buildPreviewShell({ ...PARTS, rendererJs: "a</script>b" })).toThrow(/renderer\.js/);
    expect(() => buildPreviewShell({ ...PARTS, katexJs: "a<!--b" })).toThrow(/KaTeX/);
    expect(() => buildPreviewShell({ ...PARTS, rendererCss: "a</STYLE>" })).toThrow(/stylesheet/);
    expect(() => buildPreviewShell({ ...PARTS, bootstrapJs: "</script" })).toThrow(/bootstrap/);
  });

  test("KaTeX's fonts and the brand faces are inlined as data: URIs (the frame has no network)", () => {
    const css = inlineKatexFonts(KATEX_CSS, (file) => (file === "KaTeX_Main-Regular.woff2" ? new Uint8Array([1, 2, 3]) : null));
    expect(css).toContain("url(data:font/woff2;base64,AQID)");
    // A font that cannot be read keeps its URL — blocked by the CSP, so the
    // browser falls back to a system face rather than the request going out.
    expect(css).toContain("url(/katex-fonts/KaTeX_AMS-Regular.woff2)");
    const brand = brandFontsCss((file) => (file === "inter-latin-var.woff2" ? new Uint8Array([4]) : null));
    expect(brand).toContain("font-family: 'Inter'");
    expect(brand).toContain("font-weight: 100 900");
    expect(brand).not.toContain("Josefin");
  });

  test("the real bootstrap, KaTeX and renderer can all be inlined", () => {
    expect(() =>
      buildPreviewShell({ ...PARTS, rendererJs: RENDERER.js, rendererCss: RENDERER.css, katexJs: KATEX_JS, katexCss: KATEX_CSS, baseCss: PAGE_BASE_STYLES }),
    ).not.toThrow();
    expect(PREVIEW_BOOTSTRAP_JS).not.toContain("</");
  });
});

describe("the client bytes the frame inlines are the client's (drift)", () => {
  test("PageShell.baseStyles", () => {
    expect(PAGE_BASE_STYLES).toBe(extractBaseStyles());
    const generated = readFileSync(join(import.meta.dir, "..", "lib/preview/interactive/pageShell.generated.ts"), "utf8");
    expect(generated).toBe(renderModule(extractBaseStyles()));
  });

  test("KaTeX: the design tool's package, and the copy the client vendors", () => {
    expect(KATEX_JS).toBe(readFileSync(join(import.meta.dir, "..", "node_modules/katex/dist/katex.min.js"), "utf8"));
    expect(KATEX_JS).toBe(
      readFileSync(join(REPO, "client/SecureTestCore/Sources/SecureTestCore/Resources/katex/katex.min.js"), "utf8"),
    );
  });
});

// ---------------------------------------------------------------------------
// The bootstrap against the real renderer, in the client harness's DOM shim
// (the same shim test/helpers/clientRenderer.ts uses). The shim's window is a
// plain object, so the page globals the bootstrap assigns on it are mirrored
// onto the context's global — in a browser `window` IS the global.

const SHIM = resolveLiteral(
  "domShim",
  collectLiterals([read("client/SecureTestCore/Tests/SecureTestCoreTests/RendererHarness.swift")]),
);

const ADAPTER = `
var __sent = [];
var __ready = [];
var __click = null;
var __channel = null;
function MessageChannel() {
  this.port1 = { onmessage: null, postMessage: function (m) { __sent.push(JSON.parse(JSON.stringify(m))); } };
  this.port2 = { port2: true };
  __channel = this;
}
window.parent = { postMessage: function (data, origin, ports) { __ready.push({ data: data, origin: origin, ports: ports }); } };
window.addEventListener = function () {};
document.addEventListener = function (type, fn, capture) { if (type === 'click' && capture === true) __click = fn; };
var __h1 = __node('h1');
var __source = __node('script');
__source.textContent = __RENDERER;
var __getById = document.getElementById;
document.getElementById = function (id) { return id === '${RENDERER_SOURCE_ID}' ? __source : __getById(id); };
document.querySelectorAll = function (sel) { return sel === '#items .item' ? __all('.item', __root) : []; };
document.querySelector = function (sel) {
  if (sel === 'h1') return __h1;
  var m = /^\\[data-preview-item="(\\d+)"\\]$/.exec(sel);
  if (!m) return null;
  return __all('.item', __root).filter(function (n) { return n.getAttribute('data-preview-item') === m[1]; })[0] || null;
};
var __bodyAppend = document.body.appendChild;
document.body.appendChild = function (child) {
  if (child.tagName === 'script') { __run(child.textContent); return child; }
  return __bodyAppend.call(this, child);
};
['BUNDLE', 'OFFLINE', 'TTS_SCOPE', 'STT_STATE', 'KATEX_MACROS'].forEach(function (name) {
  Object.defineProperty(this, name, { get: function () { return window[name]; } });
}, this);
var katex = { render: function (tex, el) { el.className = 'katex-stub'; el.setAttribute('data-tex', tex); } };
`;

function bootFrame() {
  const context = vm.createContext({});
  context.__RENDERER = RENDERER.js;
  context.__run = (code: string) => vm.runInContext(code, context);
  vm.runInContext(SHIM, context);
  vm.runInContext(ADAPTER, context);
  vm.runInContext(PREVIEW_BOOTSTRAP_JS, context);
  const port = () => vm.runInContext("__channel.port1", context) as { onmessage: (e: { data: unknown }) => void };
  const sent = () => vm.runInContext("__sent", context) as unknown[];
  return { context, port, sent };
}

function fixtureItems(): ItemView[] {
  return [
    {
      ...defaultItemFor("multiple_choice_single"),
      id: "q1",
      position: 0,
      stem: "Pick **two**",
      choices: [{ id: "c1", text: "One" }, { id: "c2", text: "Two" }],
      correct_choice_ids: ["c2"],
    },
    { ...defaultItemFor("short_text"), id: "q2", position: 1, stem: "Name it", correct_answer: "secretkey" },
  ] as ItemView[];
}

function payloadFor(items: ItemView[]) {
  const { bundle } = buildPreviewBundle({
    assessment: { id: "a1", name: "Fixture test", calculator_mode: "none", calculator_preset: "full", allow_highlighting: false },
    items,
    sets: [],
    layout: "scroll",
    tts: false,
    assets: {},
    saved: {},
    sealer: createPreviewSealer(),
  });
  return {
    bundle,
    offline: true as const,
    tts_scope: { items: false, stimuli: false, responses: false },
    stt_state: "off" as const,
    katex_macros: {},
  };
}

describe("the bootstrap, running the student's renderer", () => {
  test("offers one port to the parent, and nothing else, before any content", () => {
    const { context, sent } = bootFrame();
    const ready = vm.runInContext("__ready", context) as { data: unknown; origin: string; ports: unknown[] }[];
    expect(ready).toHaveLength(1);
    expect(ready[0]!.data).toEqual({ type: PREVIEW_PROTOCOL, kind: "ready", version: 1 });
    expect(ready[0]!.ports).toHaveLength(1);
    expect(sent()).toEqual([]);
    // The renderer has not run.
    expect(vm.runInContext("__all('.item', __root).length", context)).toBe(0);
  });

  test("load sets the globals, runs the renderer, tags the blocks and reports rendered", () => {
    const { context, port, sent } = bootFrame();
    port().onmessage({ data: { kind: "load", payload: payloadFor(fixtureItems()) } });
    expect(vm.runInContext("__all('.item', __root).length", context)).toBe(2);
    expect(vm.runInContext("__h1.textContent", context)).toBe("Fixture test");
    expect(vm.runInContext("OFFLINE", context)).toBe(true);
    expect(sent()).toContainEqual({ kind: "rendered", linked: true, items: 2 });
    // A second load is ignored: one frame document, one bundle.
    port().onmessage({ data: { kind: "load", payload: payloadFor([fixtureItems()[0]!]) } });
    expect(vm.runInContext("__all('.item', __root).length", context)).toBe(2);
  });

  test("an answer goes out through the stub bridge in a shape the editor page accepts", () => {
    const { context, port, sent } = bootFrame();
    port().onmessage({ data: { kind: "load", payload: payloadFor(fixtureItems()) } });
    vm.runInContext(
      "var __radio = __all('input', __all('.item', __root)[0])[1]; __radio.checked = true; __radio.onchange();",
      context,
    );
    const bridge = sent().filter((m) => (m as { kind: string }).kind === "bridge");
    expect(bridge).toHaveLength(1);
    expect(parseFrameMessage(bridge[0])).toEqual({
      kind: "response",
      item_id: "q1",
      response: { type: "multiple_choice_single", choice_id: "c2" },
    });
  });

  test("a drawing's bytes never leave the frame; hand-in posts submit", () => {
    const { context, port, sent } = bootFrame();
    port().onmessage({ data: { kind: "load", payload: payloadFor(fixtureItems()) } });
    vm.runInContext("window.webkit.messageHandlers.upload.postMessage({ item_id: 'q1', data_url: 'data:image/png;base64,AAAA' })", context);
    vm.runInContext("window.webkit.messageHandlers.submit.postMessage({ confirm: true })", context);
    const bridge = sent().filter((m) => (m as { kind: string }).kind === "bridge");
    expect(bridge).toEqual([
      { kind: "bridge", handler: "upload", body: null },
      { kind: "bridge", handler: "submit", body: { confirm: true } },
    ]);
  });

  test("the key never reaches the frame: the renderer's page holds no key value", () => {
    const { context, port } = bootFrame();
    port().onmessage({ data: { kind: "load", payload: payloadFor(fixtureItems()) } });
    const globals = vm.runInContext("JSON.stringify(window.BUNDLE)", context) as string;
    expect(globals).not.toContain("secretkey");
    expect(globals).not.toContain("correct_choice");
  });

  test("a click inside a question names it; scroll_to finds its block", () => {
    const { context, port, sent } = bootFrame();
    port().onmessage({ data: { kind: "load", payload: payloadFor(fixtureItems()) } });
    vm.runInContext(
      `var __target = __all('.stem', __all('.item', __root)[1])[0];
       (function link(n) { (n.children || []).forEach(function (c) { c.parentNode = n; link(c); }); })(__root);
       __click({ target: __target });`,
      context,
    );
    expect(sent()).toContainEqual({ kind: "jump", item_id: "q2" });
    vm.runInContext(
      "var __scrolled = null; __all('.item', __root)[1].scrollIntoView = function (o) { __scrolled = o; };",
      context,
    );
    port().onmessage({ data: { kind: "scroll_to", item_id: "q2", smooth: true } });
    expect(vm.runInContext("JSON.stringify(__scrolled)", context)).toBe('{"block":"start","behavior":"smooth"}');
  });

  test("speech callbacks reach the renderer's hooks only by name, with whole-number ranges", () => {
    const { context, port } = bootFrame();
    port().onmessage({ data: { kind: "load", payload: payloadFor(fixtureItems()) } });
    vm.runInContext(
      `var __calls = [];
       window.__secureTestSpeech = { word: function () { __calls.push(['word'].concat([].slice.call(arguments))); },
         finished: function (id) { __calls.push(['finished', id]); } };`,
      context,
    );
    port().onmessage({ data: { kind: "speech", event: "word", id: "s:1", segment: 0, offset: 2, length: 3 } });
    port().onmessage({ data: { kind: "speech", event: "word", id: "s:1", segment: 0.5, offset: 2, length: 3 } });
    port().onmessage({ data: { kind: "speech", event: "constructor", id: "s:1" } });
    port().onmessage({ data: { kind: "speech", event: "finished", id: "s:1" } });
    expect(vm.runInContext("JSON.stringify(__calls)", context)).toBe('[["word","s:1",0,2,3],["finished","s:1"]]');
  });
});

// ---------------------------------------------------------------------------
// The route: staff only, flag on only. The renderer source is stubbed so the
// test does not depend on a built packages/renderer/dist.

let principal: TestPrincipal | null = null;

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) => (principal && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined),
  }),
}));
mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () => principal,
}));
let stubRenderer: { js: string; css: string; origin: "local"; tag: string } | null = {
  js: "var renderer = 1;",
  css: ".item{}",
  origin: "local",
  tag: "t",
};
mock.module("../lib/preview/interactive/shellParts", () => ({
  loadPreviewRenderer: async () => stubRenderer,
  staticShellParts: () => ({ katexJs: "var katex = {};", katexCss: "", baseCss: PAGE_BASE_STYLES, fontsCss: "" }),
}));

const TEACHER = staffPrincipal("preview-shell-teacher", "preview-teacher@example.test");

describe("GET /preview/shell", () => {
  beforeAll(() => {
    if (!(process.env.DATABASE_URL ?? "").includes("secure_test_design_tool_test")) {
      throw new Error("preview shell route tests require the test DB");
    }
  });
  afterEach(async () => {
    principal = null;
    stubRenderer = { js: "var renderer = 1;", css: ".item{}", origin: "local", tag: "t" };
    await getDb().execute(sql`delete from staff_preferences where staff_sub = ${TEACHER.sub}`);
  });
  afterAll(async () => {
    await closeDb();
  });

  const get = async () => (await import("../app/preview/shell/route")).GET();

  test("401 without a session", async () => {
    expect((await get()).status).toBe(401);
  });

  test("404 for staff without the R-12 flag — the current editor never loads it", async () => {
    principal = TEACHER;
    expect((await get()).status).toBe(404);
  });

  test("200 with the hash-pinned CSP for flagged staff; the hashes are of the served text", async () => {
    principal = TEACHER;
    await setNewAuthoring(getDb(), TEACHER, true);
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).toContain(scriptHashSource("var renderer = 1;"));
    expect(csp).toContain(scriptHashSource("var katex = {};"));
    expect(csp).toContain(scriptHashSource(PREVIEW_BOOTSTRAP_JS));
    expect(res.headers.get("cache-control")).toBe("private, max-age=300");
    const html = await res.text();
    expect(html).toContain('<script type="text/plain" id="renderer-source">var renderer = 1;</script>');
  });

  test("503 with a script-free page when no renderer is available", async () => {
    principal = TEACHER;
    await setNewAuthoring(getDb(), TEACHER, true);
    stubRenderer = null;
    const res = await get();
    expect(res.status).toBe(503);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await res.text()).not.toContain("<script");
  });
});
