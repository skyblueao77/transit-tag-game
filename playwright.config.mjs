import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e/mobile',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    serviceWorkers: 'block',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'mobile-chrome-pixel7',
      use: { ...devices['Pixel 7'] },
    },
    {
      name: 'mobile-safari-iphone-se',
      use: { ...devices['iPhone SE'] },
    },
  ],
  webServer: {
    command: 'npx vite build --outDir dist-e2e && npx vite preview --outDir dist-e2e --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 90_000,
    env: {
      ...process.env,
      VITE_FIREBASE_API_KEY: 'demo-key',
      VITE_FIREBASE_AUTH_DOMAIN: 'demo-no-project.firebaseapp.com',
      VITE_FIREBASE_PROJECT_ID: 'demo-no-project',
      VITE_FIREBASE_STORAGE_BUCKET: 'demo-no-project.appspot.com',
      VITE_FIREBASE_MESSAGING_SENDER_ID: '123456789',
      VITE_FIREBASE_APP_ID: '1:123456789:web:abcdef',
      VITE_FIREBASE_MEASUREMENT_ID: 'G-ABCDEF',
      VITE_RECAPTCHA_ENTERPRISE_SITE_KEY: '',
      VITE_APPCHECK_DEBUG_TOKEN: '',
    },
  },
});
