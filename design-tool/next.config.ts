import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typedRoutes: true,
  // Fargate image (docs/ecs-deploy-plan.md slice 1): standalone output so
  // the runtime stage carries only traced files. The tracing root must be
  // the workspace root or @secure-test/schema is left out of the trace.
  output: "standalone",
  outputFileTracingRoot: fileURLToPath(new URL("..", import.meta.url)),
  // Multi-source stimulus slice 5 (docs/multi-source-stimulus-design.md):
  // vector figures are rasterised through @napi-rs/canvas, whose `.node`
  // binary must be traced into the standalone output rather than bundled.
  serverExternalPackages: ["@napi-rs/canvas"],
};

export default nextConfig;
