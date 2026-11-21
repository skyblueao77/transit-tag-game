import { expect } from '@playwright/test';

export const PROJECT_ID = 'demo-no-project';
export const AUTH_EMULATOR_URL = 'http://127.0.0.1:9099';
export const FIRESTORE_EMULATOR_URL = 'http://127.0.0.1:8080';

const TRANSPARENT_1PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIAAAUAAeImBZsAAAAASUVORK5CYII=',
  'base64',
);

export async function resetEmulators() {
  const authRes = await fetch(
    `${AUTH_EMULATOR_URL}/emulator/v1/projects/${PROJECT_ID}/accounts`,
    { method: 'DELETE' },
  );
  if (!authRes.ok) {
    throw new Error(`Auth Emulator reset failed: ${authRes.status}`);
  }

  const firestoreRes = await fetch(
    `${FIRESTORE_EMULATOR_URL}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  if (!firestoreRes.ok) {
    throw new Error(`Firestore Emulator reset failed: ${firestoreRes.status}`);
  }
}

export async function seedAdminAccount({
  identifier = 'admin',
  password = 'admin-password-123',
} = {}) {
  const email = identifier.includes('@') ? identifier : `${identifier}@transit-tag.local`;
  const signUpRes = await fetch(
    `${AUTH_EMULATOR_URL}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password,
        returnSecureToken: true,
      }),
    },
  );
  if (!signUpRes.ok) {
    throw new Error(`Failed to seed admin Auth account: ${signUpRes.status} ${await signUpRes.text()}`);
  }
  const authData = await signUpRes.json();

  const docRes = await fetch(
    `${FIRESTORE_EMULATOR_URL}/v1/projects/${PROJECT_ID}/databases/(default)/documents/admins/${authData.localId}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer owner',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fields: {
          role: { stringValue: 'admin' },
          createdAt: { timestampValue: new Date().toISOString() },
        },
      }),
    },
  );
  if (!docRes.ok) {
    throw new Error(`Failed to seed admin Firestore document: ${docRes.status} ${await docRes.text()}`);
  }

  return {
    uid: authData.localId,
    idToken: authData.idToken,
    identifier,
    password,
  };
}

export function buildMobileContextOptions(testInfo) {
  const use = testInfo.project.use;
  return {
    baseURL: use.baseURL,
    viewport: use.viewport,
    userAgent: use.userAgent,
    deviceScaleFactor: use.deviceScaleFactor,
    isMobile: use.isMobile,
    hasTouch: use.hasTouch,
    serviceWorkers: 'block',
  };
}

export async function attachMobileTestHooks(
  page,
  coords = { latitude: 35.681236, longitude: 139.767125, accuracy: 15 },
) {
  const errors = [];
  let allowOfflineErrors = false;
  const isWebKit = page.context().browser()?.browserType().name() === 'webkit';

  page.on('pageerror', error => {
    errors.push(`pageerror: ${error.message}`);
  });
  page.on('console', msg => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (
      isWebKit
      && (
        text.includes('Send failed since rewinding of the data stream failed')
        || (
          text.includes('Beacon API cannot load http://127.0.0.1:8080/google.firestore.v1.Firestore/')
          && text.includes('TYPE=terminate')
          && text.includes('WebKit encountered an internal error')
        )
      )
    ) {
      // Windows Playwright WebKit (libcurl) logs transient transport/beacon teardown
      // errors on long-lived localhost Firestore WebChannel streams that do not affect app state.
      return;
    }
    if (
      allowOfflineErrors
      && (text.includes('ERR_INTERNET_DISCONNECTED')
        || text.includes('Failed to fetch')
        || text.includes('Offline')
        || text.includes('network')
        || text.includes('WebChannel')
        || text.includes('WebKit encountered an internal error')
        || text.includes('Failed to load resource'))
    ) {
      return;
    }
    errors.push(`console.error: ${text}`);
  });

  await page.route('**/cyberjapandata.gsi.go.jp/**', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: TRANSPARENT_1PX_PNG,
    });
  });

  await page.addInitScript(() => {
    const injectStyle = () => {
      const style = document.createElement('style');
      style.textContent = '.firebase-emulator-warning { display: none !important; pointer-events: none !important; }';
      (document.head || document.documentElement).appendChild(style);
    };
    if (document.documentElement) {
      injectStyle();
    } else {
      window.addEventListener('DOMContentLoaded', injectStyle, { once: true });
    }
  });

  await page.addInitScript(({ latitude, longitude, accuracy }) => {
    const fixedCoords = {
      latitude,
      longitude,
      accuracy,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
      toJSON() {
        return { latitude: this.latitude, longitude: this.longitude, accuracy: this.accuracy };
      },
    };
    let nextWatchId = 1;
    const timers = new Map();
    const mockGeolocation = {
      getCurrentPosition(success) {
        setTimeout(() => success({ coords: fixedCoords, timestamp: Date.now() }), 10);
      },
      watchPosition(success) {
        const id = nextWatchId++;
        const timer = setTimeout(() => success({ coords: fixedCoords, timestamp: Date.now() }), 15);
        timers.set(id, timer);
        return id;
      },
      clearWatch(id) {
        const timer = timers.get(id);
        if (timer !== undefined) {
          clearTimeout(timer);
          timers.delete(id);
        }
      },
    };
    try {
      Object.defineProperty(navigator, 'geolocation', {
        configurable: true,
        value: mockGeolocation,
      });
    } catch {
      Object.defineProperty(Navigator.prototype, 'geolocation', {
        configurable: true,
        value: mockGeolocation,
      });
    }
  }, coords);

  return {
    errors,
    setAllowOfflineErrors(allowed) {
      allowOfflineErrors = allowed;
    },
  };
}

export async function assertNoHorizontalOverflow(page, label) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(
    overflow,
    `Horizontal overflow detected at "${label}": ${overflow}px`,
  ).toBeLessThanOrEqual(1);
}

export async function assertMobileInputFontSize(page, label) {
  const offenders = await page.evaluate(() => {
    const candidates = document.querySelectorAll('input, select, textarea');
    const results = [];
    for (const el of candidates) {
      if (!(el instanceof HTMLElement)) continue;
      const type = el.getAttribute('type');
      if (type === 'checkbox' || type === 'radio' || type === 'file' || type === 'hidden') {
        continue;
      }
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      const fontSize = Number.parseFloat(style.fontSize);
      if (fontSize < 16) {
        results.push({
          tag: el.tagName,
          id: el.id || null,
          fontSize,
        });
      }
    }
    return results;
  });

  expect(
    offenders,
    `Inputs < 16px on "${label}" trigger iOS auto-zoom: ${JSON.stringify(offenders)}`,
  ).toEqual([]);
}
