import {fileURLToPath} from "node:url";
import {defineConfig} from "vitest/config";

const sourceDirectory=fileURLToPath(new URL("./src",import.meta.url));

export default defineConfig({
  resolve:{
    alias:{
      "@":sourceDirectory,
    },
  },
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
