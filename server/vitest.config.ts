/**
 * Vitest config. One important choice: fileParallelism: false.
 * All test files share ONE test database, so they must run one
 * after another — parallel files would trample each other's data.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    include: ["src/**/*.test.ts"],
  },
});
