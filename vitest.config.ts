import {defineConfig} from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.integration.test.ts"],
    coverage: {
      include: ["src/lib/**/*.ts"],
      reporter: ["text", "html"],
    },
  },
});
