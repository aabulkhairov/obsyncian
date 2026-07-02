import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  resolve: {
    alias: {
      obsidian: resolve(__dirname, "test/obsidian-mock.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
