import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The provisioning pipeline shells out to the Prisma CLI (child_process)
  // and loads Prisma engines at runtime. When Turbopack bundles it into the
  // server bundle, those spawns break (spawnSync <node> ENOENT on Windows).
  // Keep these packages as regular Node modules.
  serverExternalPackages: [
    "@school-erp/provisioning-service",
    "@school-erp/control-plane",
    "@school-erp/tenant",
    "@school-erp/database",
    "prisma",
    "@prisma/client",
  ],
};

export default nextConfig;