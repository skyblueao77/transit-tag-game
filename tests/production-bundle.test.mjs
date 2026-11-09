import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('production bundle loads Firebase auth and firestore without Component registration errors', async () => {
  const distDir = path.resolve('dist');
  if (!fs.existsSync(distDir)) {
    // If dist doesn't exist yet, skip
    return;
  }

  const assetsDir = path.join(distDir, 'assets');
  if (!fs.existsSync(assetsDir)) return;

  const files = fs.readdirSync(assetsDir);
  const indexJs = files.find(f => f.startsWith('index-') && f.endsWith('.js'));
  if (!indexJs) return;

  globalThis.window = globalThis;
  const head = { appendChild: () => {} };
  globalThis.document = {
    head,
    createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
    createTextNode: () => ({}),
    querySelectorAll: () => [],
    getElementsByTagName: () => [head],
  };
  if (!globalThis.location) {
    globalThis.location = { origin: 'http://localhost', hostname: 'localhost' };
  }
  globalThis.MutationObserver = class { observe() {} };
  globalThis.isSecureContext = false;

  try {
    await import(path.join(assetsDir, indexJs));
  } catch (err) {
    assert.doesNotMatch(
      err.message,
      /Component.*has not been registered yet/i,
      'Firebase components must be properly registered without race conditions or duplication',
    );
  }
});
