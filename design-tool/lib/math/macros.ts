// Re-export of the canonical K-12 macro set. The actual definitions live
// in @secure-test/schema/src/macros.ts (slice 16) so the design-tool's
// SSR renderer and PoC-B's inline-JS renderer can't drift apart. Local
// consumers keep the existing `@/lib/math/macros` import path.

export { K12_MACROS } from "@secure-test/schema";
