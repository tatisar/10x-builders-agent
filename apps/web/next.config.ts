import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const appDir = path.dirname(fileURLToPath(import.meta.url));
// next is hoisted to the monorepo root in this npm workspaces setup
const monorepoRoot = path.resolve(appDir, "../..");

const extraAllowedDevOrigins =
  process.env.NEXT_ALLOWED_DEV_ORIGINS?.split(",")
    .map((h) => h.trim())
    .filter(Boolean) ?? [];

const allowedDevOrigins = [
  "*.ngrok-free.app",
  "*.ngrok-free.dev",
  "*.ngrok.app",
  ...extraAllowedDevOrigins,
];

const nextConfig: NextConfig = {
  // Use the monorepo root so Turbopack resolves hoisted `next` and this repo's lockfile.
  turbopack: {
    root: monorepoRoot,
  },
  transpilePackages: ["@agents/agent", "@agents/db", "@agents/types"],
  serverExternalPackages: ["@langchain/core", "@langchain/langgraph", "@langchain/openai"],
  allowedDevOrigins,
};

export default nextConfig;
