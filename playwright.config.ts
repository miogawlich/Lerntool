import { defineConfig, devices } from "@playwright/test";

// Chromium ist in der Cloud-Umgebung vorinstalliert; lokal nutzt Playwright seinen eigenen Browser.
const executablePath = process.env.CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:4173",
    serviceWorkers: "block",
    launchOptions: { executablePath },
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "ipad",
      // iPad Pro 11" im Querformat (WebKit ist hier nicht verfügbar → Chromium mit iPad-Viewport)
      use: { ...devices["Desktop Chrome"], viewport: { width: 1194, height: 834 }, deviceScaleFactor: 2, hasTouch: true },
    },
  ],
  webServer: {
    command: "npx vite build && npx vite preview --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
