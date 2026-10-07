import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep Turbopack rooted here even if a lockfile exists higher up the tree.
  outputFileTracingRoot: import.meta.dirname,
  turbopack: {
    root: import.meta.dirname,
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
