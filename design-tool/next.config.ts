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
};

export default nextConfig;
