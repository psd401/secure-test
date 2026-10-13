// Writes src/keys.ts from keys/*.pub.pem (see scripts/keys-module.ts).
//
//   bun run keys   (from packages/renderer)

import { writeFileSync } from "node:fs";
import { KEYS_MODULE, readPublicKeys, renderKeysModule } from "./keys-module";

const keys = readPublicKeys();
writeFileSync(KEYS_MODULE, renderKeysModule(keys));
console.log(`src/keys.ts: ${keys.map((k) => k.name).join(", ")}`);
