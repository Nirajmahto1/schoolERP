import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // Docker builds set NEXT_OUTPUT=standalone (docker/Dockerfile.nextjs);
  // `next dev` and local `next start` are unaffected.
  ...(process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone" as const } : {}),
};

export default nextConfig;
