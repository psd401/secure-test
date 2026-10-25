// MathLive, re-exported so the design tool loads the exact version this
// package pins (0.111.1, D-2) without depending on it directly.
//
// Read off the namespace, not re-exported by name: Next also compiles a
// client component for the server, where the "node" condition resolves
// MathLive's SSR build, which has no MathfieldElement — a named re-export
// fails that build. Only the browser ever calls this (from an effect).
import * as MathLive from "mathlive";

export const MathfieldElement = (MathLive as { MathfieldElement: typeof import("mathlive").MathfieldElement })
  .MathfieldElement;
