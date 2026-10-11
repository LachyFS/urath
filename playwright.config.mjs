import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 45000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4184",
    viewport: { width: 1280, height: 900 },
    trace: "retain-on-failure",
    launchOptions: {
      args:
        process.env.URATH_TEST_GPU === "1"
          ? ["--use-angle=vulkan", "--enable-gpu"]
          : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    },
  },
  webServer: {
    command:
      "npm run preview -w urath-demo -- --host 127.0.0.1 --port 4184 --strictPort",
    url: "http://127.0.0.1:4184",
    reuseExistingServer: false,
  },
});
