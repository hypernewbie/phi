import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, ipcMain, screen } from 'electron';

const root = process.env.CHECK_DIR;
if (!root || !path.isAbsolute(root)) throw new Error('CHECK_DIR must be absolute');
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
for (const name of ['home', 'appData', 'userData', 'sessionData']) {
  const value = path.join(root, 'client', name);
  mkdirSync(value, { recursive: true });
  app.setPath(name, value);
}
// This launcher lives in test/, but the real app assets live at packageRoot.
app.getAppPath = () => packageRoot;
ipcMain.on('phi:rail-menu-size', (event, height) => {
  if (typeof height !== 'number') return;
  console.log('RAIL_CHECK_REPORT ' + JSON.stringify({ id: event.sender.id, height }));
});
app.on('web-contents-created', (_event, contents) => {
  const id = contents.id;
  let lastURL = '';
  contents.on('did-navigate', (_navigation, url) => { lastURL = url; });
  contents.once('destroyed', () => {
    console.log('RAIL_CHECK_DESTROYED ' + JSON.stringify({ id, url: lastURL }));
  });
});
app.on('browser-window-created', (_event, win) => {
  win.on('resize', () => {
    if (win.isDestroyed() || win.getTitle() !== 'Phi server menu') return;
    const parent = win.getParentWindow();
    const display = screen.getDisplayMatching(win.getBounds());
    console.log('RAIL_CHECK_SIZE ' + JSON.stringify({
      id: win.webContents.id,
      content: win.getContentSize(), bounds: win.getBounds(),
      area: parent?.isFullScreen() ? display.bounds : display.workArea,
    }));
  });
});
console.log('RAIL_CHECK_USER_DATA ' + app.getPath('userData'));
await import('../dist/main.js');
