import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emits a self-contained server with only the traced runtime deps, which is what the
  // Dockerfile's runner stage copies.
  output: "standalone",
};

export default nextConfig;
