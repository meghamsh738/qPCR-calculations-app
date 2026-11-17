import { defineConfig, devices } from '@playwright/test'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const moduleRoot = path.resolve(__dirname, '..')
const moduleRequire = createRequire(import.meta.url)
const runtime = moduleRequire(path.join(moduleRoot, 'desktop', 'electron', 'next-runtime.cjs'))
const runtimeLayout = runtime.resolveRuntimeLayout({ projectRoot: moduleRoot })
process.env.PLAYWRIGHT_BROWSERS_PATH = runtime.assertNoSymlinkPathComponents(runtimeLayout.browserCachePath)
runtime.assertNoSymlinkPathComponents(runtimeLayout.browserTestOutputPath)

export default defineConfig({
  testDir: './tests',
  outputDir: runtimeLayout.browserTestOutputPath,
  timeout: 120_000,
  fullyParallel: true,
  expect: {
    timeout: 15000,
    toHaveScreenshot: { animations: 'disabled', caret: 'hide' }
  },
  use: {
    baseURL: 'http://127.0.0.1:19512',
    trace: 'on-first-retry',
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
    video: 'retain-on-failure'
  },
  webServer: {
    // Spin up both frontend (Vite) and backend (FastAPI) so the flow can hit /plan without manual servers.
    command: 'npm run dev:full',
    url: 'http://127.0.0.1:19512',
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'ignore'
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chromium'],
        viewport: { width: 1440, height: 900 },
        colorScheme: 'light',
        reducedMotion: 'reduce'
      }
    }
  ]
})
