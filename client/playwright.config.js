import { defineConfig } from '@playwright/test';

/**
 * UI smoke + accessibility suite (see e2e/README in the header of global-setup.js).
 *
 * The real backend is started by e2e/global-setup.js on a random port and serves
 * the BUILT client (`npm run build` first), so what is tested is what ships.
 *
 * Browser: set PW_CHROMIUM_PATH to a Chromium/Chrome executable to use it instead
 * of Playwright's managed download (used in sandboxes where `playwright install`
 * is not possible). In CI the managed browser is installed with
 * `npx playwright install --with-deps chromium` and the variable is left unset.
 */
// A random port, chosen once: workers inherit the environment of the main process, so config and
// global-setup agree on it. Set E2E_PORT to pin it.
const port = (process.env.E2E_PORT ||= String(20000 + Math.floor(Math.random() * 30000)));

const executablePath = process.env.PW_CHROMIUM_PATH || undefined;

const desktop = { viewport: { width: 1440, height: 900 } };
const mobile = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.js',
  // One shared backend with real state (devices, brokers): run serially and deterministically.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    launchOptions: { executablePath },
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    reducedMotion: 'reduce',
    // The app follows the OS theme by default; the suite runs dark unless a test picks a theme.
    colorScheme: 'dark'
  },
  // Tests are routed to projects by tag instead of being skipped: @touch tests need a phone with a
  // touchscreen and run only in mobile-touch; @desktop-only tests stay out of the phone projects.
  projects: [
    // Every spec runs on desktop except the phone-only ones, so a new *.spec.js file needs no registration here.
    { name: 'desktop', use: desktop, testMatch: /.*\.spec\.js$/, testIgnore: ['**/mobile-nav.spec.js'], grepInvert: /@touch/ },
    // Canvas renderers again at devicePixelRatio 2: backing-store size and hit-testing must hold on HiDPI.
    { name: 'hidpi', use: { ...desktop, deviceScaleFactor: 2 }, testMatch: ['canvas.spec.js'], grepInvert: /@touch/ },
    { name: 'mobile', use: mobile, testMatch: ['routes.spec.js', 'mobile-nav.spec.js'], grepInvert: /@desktop-only/ },
    { name: 'mobile-touch', use: mobile, testMatch: ['canvas.spec.js'], grep: /@touch/ }
  ]
});
