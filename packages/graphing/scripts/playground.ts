// `bun run playground` — serves the slice-2 playground on localhost.
// KaTeX's stylesheet and fonts come from the design tool's copy (the same
// version the client vendors), so MathLive finds the KaTeX faces already
// loaded, as it will in the test page.
import { join, normalize, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const KATEX = resolve(ROOT, "..", "..", "design-tool", "node_modules", "katex", "dist");
const PORT = Number(process.env.PORT ?? 4178);

async function bundle(): Promise<Response> {
  const out = await Bun.build({ entrypoints: [join(ROOT, "playground", "main.ts")], target: "browser", format: "iife", minify: false });
  if (!out.success) return new Response(out.logs.map(String).join("\n"), { status: 500 });
  return new Response(await out.outputs[0]!.text(), { headers: { "content-type": "text/javascript" } });
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/" || pathname === "/index.html") return new Response(Bun.file(join(ROOT, "playground", "index.html")));
    if (pathname === "/app.js") return bundle();
    if (pathname.startsWith("/katex/")) {
      const rel = normalize(pathname.slice("/katex/".length));
      if (rel.startsWith("..")) return new Response("no", { status: 404 });
      const f = Bun.file(join(KATEX, rel));
      if (await f.exists()) return new Response(f);
    }
    return new Response("not found", { status: 404 });
  },
});
console.log(`playground on http://127.0.0.1:${PORT}`);
