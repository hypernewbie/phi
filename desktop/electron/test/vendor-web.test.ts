// @vitest-environment node
/**
 * The desktop main view loads the browser Phi module graph from
 * `desktop/electron/web/vendor/`, which `scripts/vendor-web.mjs` fills from
 * the repo-root `web/`. It copies every top-level `web/*.js` (no hand list:
 * `b35d902` added `web/model-request.js` and the list missed it, so the
 * vendored copy kept a sibling import that resolved to nothing and the whole
 * main view failed to load).
 *
 * This is the static half of that guard: every sibling import a browser
 * module makes names a file that exists in `web/`, so the copy cannot miss a
 * dependency. `regen.test.ts` checks the copied bytes; the vendoring script
 * asserts the same resolution when it runs.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(here, '..', '..', '..', 'web');

const browserModules = readdirSync(webRoot).filter((name) =>
  name.endsWith('.js'),
);

describe('desktop web vendoring', () => {
  it('vendors every top-level browser module', () => {
    const vendored = readdirSync(path.join(here, '..', 'web', 'vendor')).filter(
      (name) => name.endsWith('.js'),
    );
    expect(browserModules.filter((name) => !vendored.includes(name))).toEqual(
      [],
    );
  });

  it('resolves every sibling import to a module in the browser tree', () => {
    const missing = browserModules.flatMap((name) =>
      Array.from(
        readFileSync(path.join(webRoot, name), 'utf8').matchAll(
          /from '\.\/([\w.-]+\.js)'/g,
        ),
        (match) => ({ dep: match[1], importer: `web/${name}` }),
      ),
    );
    expect(
      missing.filter(({ dep }) => !existsSync(path.join(webRoot, dep))),
    ).toEqual([]);
  });
});
