import { app, session } from 'electron';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.PHI_E2E_DESKTOP_ROOT;
const mainEntry = process.env.PHI_E2E_DESKTOP_MAIN;
const allowedOrigins = new Set(
  JSON.parse(process.env.PHI_E2E_ALLOWED_ORIGINS ?? '[]'),
);
if (!root || !path.isAbsolute(root) || !mainEntry || !path.isAbsolute(mainEntry)) {
  throw new Error('Stream Deck E2E paths must be absolute');
}

const paths = {
  home: path.join(root, 'home'),
  appData: path.join(root, 'app-data'),
  userData: path.join(root, 'user-data'),
  sessionData: path.join(root, 'session-data'),
  temp: path.join(root, 'tmp'),
  logs: path.join(root, 'logs'),
  crashDumps: path.join(root, 'crash-dumps'),
};
for (const directory of Object.values(paths)) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
}
for (const [name, directory] of Object.entries(paths)) {
  app.setPath(name, directory);
}

const diagnostics = {
  consoleErrors: [],
  failedLoads: [],
  failedRequests: [],
  blockedOrigins: [],
};
globalThis.__phiStreamDeckE2EDiagnostics = diagnostics;

app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (details) => {
    if (details.level === 'error') {
      diagnostics.consoleErrors.push(`${contents.getURL()}: ${details.message}`);
    }
  });
  contents.on(
    'did-fail-load',
    (_event, code, description, failedUrl, isMainFrame) => {
      if (code !== -3) {
        let origin = 'invalid-url';
        try {
          origin = new URL(failedUrl).origin;
        } catch {
          // Preserve the load failure even when Chromium supplies no URL.
        }
        diagnostics.failedLoads.push({ code, description, origin, isMainFrame });
      }
    },
  );
});

app.once('ready', () => {
  session.defaultSession.webRequest.onErrorOccurred(
    { urls: ['<all_urls>'] },
    ({ url, error, resourceType }) => {
      diagnostics.failedRequests.push({ url, error, resourceType });
    },
  );
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['<all_urls>'] },
    (details, callback) => {
      let allowed = details.url.startsWith('file:');
      let origin = '';
      try {
        const url = new URL(details.url);
        origin = url.origin;
        if (url.protocol === 'http:' || url.protocol === 'https:') {
          allowed = allowedOrigins.has(url.origin);
        } else if (url.protocol === 'ws:' || url.protocol === 'wss:') {
          const httpOrigin = `${url.protocol === 'ws:' ? 'http:' : 'https:'}//${url.host}`;
          allowed = allowedOrigins.has(httpOrigin);
        }
      } catch {
        allowed = false;
      }
      if (!allowed) diagnostics.blockedOrigins.push(origin || 'invalid-url');
      callback({ cancel: !allowed });
    },
  );
});

await import(pathToFileURL(mainEntry).href);
