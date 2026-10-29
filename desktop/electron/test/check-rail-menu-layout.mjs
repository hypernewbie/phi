import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--allow-file-access-from-files'],
});
const state = {
  profile: {
    id: 'layout-check', name: 'Alpha Phi',
    origin: 'http://127.0.0.1:17072/', hostname: 'charon.local',
    accent: '#e76f51', cpu: 62,
  },
  health: 'up', unread: 3,
};

try {
  for (const touch of [false, true]) {
    const context = await browser.newContext({
      viewport: { width: 320, height: 460 },
      isMobile: touch, hasTouch: touch, deviceScaleFactor: touch ? 2 : 1,
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('requestfailed', (request) => errors.push(request.url()));
    await page.addInitScript(() => {
      window.__railReports = [];
      const noop = () => {};
      window.electron = {
        onRailMenuState: (callback) => { window.__railState = callback; },
        postRailMenuSize: (height) => window.__railReports.push(height),
        postCloseRailMenu: noop, postOpenServerSessions: noop,
        postReloadServer: noop, postReloadAllServers: noop,
        postCopyServerUrl: noop, postCopyAllServers: noop,
        postRenameProfile: noop, postRemoveProfile: noop,
      };
    });
    const url = pathToFileURL(path.join(packageRoot, 'dist/rail-menu.html'));
    url.searchParams.set('profile', state.profile.id);
    await page.goto(url.href);
    await page.waitForFunction(() => typeof window.__railState === 'function');
    await page.evaluate((value) => window.__railState(value), state);
    await page.evaluate(() => document.fonts.ready);

    async function geometry(mode) {
      await page.waitForFunction(() => {
        const panel = document.querySelector('.rail-menu-panel');
        if (!panel) return false;
        const style = getComputedStyle(document.body);
        const expected = Math.ceil(panel.getBoundingClientRect().height +
          parseFloat(style.paddingTop) + parseFloat(style.paddingBottom));
        return window.__railReports.at(-1) === expected;
      });
      const reported = await page.evaluate(() => window.__railReports.at(-1));
      await page.setViewportSize({ width: 320, height: reported });
      const result = await page.evaluate(() => {
        const panel = document.querySelector('.rail-menu-panel');
        const box = panel.getBoundingClientRect();
        const style = getComputedStyle(document.body);
        const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
        return {
          reported: window.__railReports.at(-1),
          expected: Math.ceil(box.height + padding),
          bottom: box.bottom + parseFloat(style.paddingBottom),
          width: innerWidth, scrollWidth: document.body.scrollWidth,
          header: !!panel.querySelector('.rail-menu-header'),
        };
      });
      assert.equal(result.reported, result.expected);
      assert.ok(result.bottom <= result.reported);
      assert.equal(result.width, 320);
      assert.ok(result.scrollWidth <= 320);
      assert.ok(result.header);
      console.log('RAIL_LAYOUT ' + JSON.stringify({ mode, touch, ...result }));
      return result.reported;
    }

    const actions = await geometry('actions');
    const remove = page.getByRole('menuitem', { name: 'Remove server', exact: true });
    const removeBox = await remove.boundingBox();
    assert.ok(removeBox && removeBox.y + removeBox.height <= actions);
    if (process.env.CHECK_DIR && !touch) {
      await page.screenshot({ path: path.join(process.env.CHECK_DIR, 'actions.png') });
    }
    if (process.env.RAIL_LAYOUT_ACTIONS_ONLY === '1') { await context.close(); continue; }
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    const rename = await geometry('rename');
    assert.notEqual(rename, actions);
    await page.waitForFunction(() => document.activeElement?.matches('.rail-menu-input'));
    await page.getByRole('menuitem', { name: 'Cancel', exact: true }).click();
    await geometry('actions-return');
    await remove.click();
    const confirmation = await geometry('remove');
    assert.notEqual(confirmation, actions);
    assert.notEqual(confirmation, rename);
    await page.getByRole('menuitem', { name: 'Keep server', exact: true }).click();
    await geometry('actions-return');

    await page.evaluate(() => {
      const panel = document.querySelector('.rail-menu-panel');
      window.__extraRailRow = panel.querySelector('.rail-menu-action').cloneNode(true);
      panel.append(window.__extraRailRow);
    });
    await page.waitForFunction((old) => window.__railReports.at(-1) > old, actions);
    await geometry('extra-row');
    await page.evaluate(() => window.__extraRailRow.remove());
    await page.waitForFunction((old) => window.__railReports.at(-1) === old, actions);

    await page.setViewportSize({ width: 320, height: 250 });
    await remove.focus();
    await remove.scrollIntoViewIfNeeded();
    const short = await page.evaluate(() => {
      const button = [...document.querySelectorAll('.rail-menu-action')]
        .find((item) => item.textContent.includes('Remove server'));
      const box = button.getBoundingClientRect();
      return {
        top: box.top, bottom: box.bottom, viewport: innerHeight,
        scrollTop: document.body.scrollTop,
        overflow: getComputedStyle(document.body).overflowY,
        reported: window.__railReports.at(-1),
      };
    });
    assert.equal(short.overflow, 'auto');
    assert.ok(short.scrollTop > 0);
    assert.ok(short.top >= 0 && short.bottom <= short.viewport);
    assert.equal(short.reported, actions);
    console.log('RAIL_SCROLL ' + JSON.stringify({ touch, ...short }));
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(process.env.RAIL_LAYOUT_ACTIONS_ONLY === '1'
    ? 'RAIL_LAYOUT_ACTIONS_PASS' : 'RAIL_LAYOUT_PASS');
} finally {
  await browser.close();
}
