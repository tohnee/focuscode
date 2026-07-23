import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/test/**/*.test.ts", "apps/**/test/**/*.test.ts", "tests/**/*.test.ts"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "reports/coverage",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/dist/**", "**/src/index.ts", "packages/testkit/src/**"],
      thresholds: {
        statements: 75,
        branches: 60,
        functions: 80,
        lines: 80,
      },
    },
  },
});
