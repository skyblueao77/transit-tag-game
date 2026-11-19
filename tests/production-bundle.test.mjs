import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('production bundle loads Firebase auth and firestore without Component registration errors', async () => {
  const distDir = path.resolve('dist');
  assert.equal(fs.existsSync(distDir), true, 'dist directory must exist (run npm run build before npm run test:bundle)');

  const assetsDir = path.join(distDir, 'assets');
  assert.equal(fs.existsSync(assetsDir), true, 'dist/assets directory must exist');

  const files = fs.readdirSync(assetsDir);
  const indexJs = files.find(f => f.startsWith('index-') && f.endsWith('.js'));
  assert.ok(indexJs, 'dist/assets must contain built index-*.js bundle');

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

  assert.equal(fs.existsSync(path.join(distDir, 'data', 'stations.json')), true, 'dist/data/stations.json must be emitted');
  const swContent = fs.readFileSync(path.join(distDir, 'sw.js'), 'utf8');
  assert.match(swContent, /data\/stations\.json/, 'Service worker precache manifest must include data/stations.json');

  for (const file of files) {
    if (file.endsWith('.js')) {
      const size = fs.statSync(path.join(assetsDir, file)).size;
      assert.ok(size < 1_000_000, `Expected ${file} (${size} bytes) not to inline the 2.2MB stations.json dataset`);
    }
  }

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
