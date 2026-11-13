import react from '@vitejs/plugin-react';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let serverPromise = null;

async function getViteSsrServer() {
  if (!serverPromise) {
    serverPromise = createServer({
      configFile: false,
      plugins: [react()],
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true },
      appType: 'custom',
      logLevel: 'silent',
    });
  }
  return serverPromise;
}

export async function loadSsrModule(modulePath) {
  const server = await getViteSsrServer();
  return server.ssrLoadModule(modulePath);
}

export async function renderSsrComponent(modulePath, props = {}, exportName = 'default') {
  const mod = await loadSsrModule(modulePath);
  const Component = mod[exportName];
  if (typeof Component !== 'function') {
    throw new Error(`Export "${exportName}" from ${modulePath} is not a component function`);
  }
  return renderToStaticMarkup(React.createElement(Component, props));
}

export async function closeViteSsrServer() {
  if (!serverPromise) return;
  const server = await serverPromise;
  serverPromise = null;
  await server.close();
}
