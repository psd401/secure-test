import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { PRODUCT_NAME } from "../lib/brand";

// Row NM (CLAUDE.md "Naming"): the product name a person reads comes from
// `lib/brand.ts`. A hand-typed old form ("Secure Test", "Secure-Test") in
// the app's own source or its public pages is drift. Identifiers
// (`secure-test`, `SecureTest`) are not product names and are not checked.
const ROOT = join(import.meta.dir, "..");
const SCANNED = ["app", "components", "lib", "public", "proxy.ts"];
const OLD_FORMS = /Secure[ -]Test/;

function files(path: string): string[] {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path).flatMap((name) => files(join(path, name)));
}

describe("product name", () => {
  test("is SecureTest", () => {
    expect(PRODUCT_NAME).toBe("SecureTest");
  });

  test("no hand-typed old form in the app's source", () => {
    const hits: string[] = [];
    for (const top of SCANNED) {
      for (const file of files(join(ROOT, top))) {
        if (!/\.(ts|tsx|js|css|html)$/.test(file)) continue;
        readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (OLD_FORMS.test(line)) hits.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
          });
      }
    }
    expect(hits).toEqual([]);
  });
});
