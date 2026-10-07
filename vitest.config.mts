import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(import.meta.dirname, "supabase/functions/_shared"),
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  test: { include: ["tests/**/*.test.ts"] },
});
