// @vitest-environment node
/**
 * The desktop main view loads the browser Phi module graph from
 * `desktop/electron/web/vendor/`, which `scripts/vendor-web.mjs` fills from
 * the repo-root `web/` by an explicit `WEB_JS_MODULES` list. A module added
 * to that graph therefore has to be listed too, or the vendored copy keeps a
 * sibling import that resolves to nothing and the whole main view fails to
 * load. `b35d902` added `web/model-request.js` without listing it, which did
 * exactly that. This is the guard: every sibling import is listed, and every
 * listed module exists.
 *
 * Sibling imports only. Anything under `web/vendor/` is copied by the
 * separate `WEB_VENDOR_DIRS` mechanism, not this list.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(here, '..', '..', '..', 'web');
const vendorScriptPath = path.join(here, '..', 'scripts', 'vendor-web.mjs');

const vendorScript = readFileSync(vendorScriptPath, 'utf8');
const listStart = vendorScript.indexOf('const WEB_JS_MODULES = [');
const listEnd = vendorScript.indexOf('];', listStart);
const vendoredModules = Array.from(
  vendorScript.slice(listStart, listEnd).matchAll(/'([\w.-]+\.js)'/g),
  (match) => match[1],
);

describe('desktop web vendoring', () => {
  it('parses a non-empty module list from the vendoring script', () => {
    expect(listStart).toBeGreaterThan(-1);
    expect(vendoredModules.length).toBeGreaterThan(0);
  });

  it('lists every sibling module the browser graph imports', () => {
    const missing = readdirSync(webRoot)
      .filter((name) => name.endsWith('.js'))
      .flatMap((name) =>
        Array.from(
          readFileSync(path.join(webRoot, name), 'utf8').matchAll(
            /from '\.\/([\w.-]+\.js)'/g,
          ),
          (match) => ({ dep: match[1], importer: `web/${name}` }),
        ),
      )
      .filter(({ dep }) => !vendoredModules.includes(dep));
    expect(missing).toEqual([]);
  });

  it('lists only modules that exist in the browser source tree', () => {
    expect(
      vendoredModules.filter((name) => !existsSync(path.join(webRoot, name))),
    ).toEqual([]);
  });
});
