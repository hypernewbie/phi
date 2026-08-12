// Renders the desktop's Φ icon by rasterizing the ACTUAL Phi brand
// glyph (U+03A6) in the exact font the TBAR uses (JetBrains Mono,
// --font-mono in web/style.css). The woff2 lives in
// web/vendor/fonts/jetbrainsmono-*.woff2; we decompress it via
// wawoff2 into a TTF that PowerShell + System.Drawing can load
// through PrivateFontCollection.
//
// The glyph is rendered at a 1024x1024 master canvas and downscaled
// to each target size (16/24/32/48/64/128/256 for the multi-size
// ICO, plus 256 for the application icon). For the 16x16 tray
// variant this is 64x supersampling per axis, which is the only way
// to land a clean Φ at that resolution without hand-tuned hinting.
//
// Output:
//   - assets/icon.png  : 256x256 application/window fallback
//   - assets/icon.ico  : multi-size ICO (16/24/32/48/64/128/256)
//   - assets/tray.ico  : same multi-size ICO for the tray
//   - assets/icons/icon-<theme>.png  : per-accent window variants
//   - assets/icons/manifest.json     : accent hex -> icon filename
//
// Per-accent variants use the SAME glyph in the active server's
// highlight accent (the same ACCENT_COLORS web/app.js exports). The
// host loop picks the variant via appicon.ts -> iconResolver; the
// white brand icon is the fallback when no accent is observed yet.
//
// No image dependency; the ICO container is hand-assembled. Re-run
// any time; output is deterministic.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import wawoff2 from 'wawoff2';

const here = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(here, '..', 'assets');
const OUT_ICON = path.join(ASSETS, 'icon.png');
const OUT_ICON_ICO = path.join(ASSETS, 'icon.ico');
const OUT_TRAY_PNG = path.join(ASSETS, 'tray.png');
const OUT_TRAY_ICO = path.join(ASSETS, 'tray.ico');
const OUT_TTF = path.join(ASSETS, 'jetbrainsmono.ttf');
const ICONS_DIR = path.join(ASSETS, 'icons');

// GDI+ is only available on Windows. The checked-in assets are generated
// there and are the portable packaging input for Linux and macOS; those
// platforms must not try to invoke PowerShell during their builds.
if (process.platform !== 'win32') {
  console.log('gen-icon: non-Windows host; using committed icon assets');
  process.exit(0);
}

const WEB_APP_JS = path.join(here, '..', '..', '..', 'web', 'app.js');
const WEB_FONTS_DIR = path.join(here, '..', '..', '..', 'web', 'vendor', 'fonts');

const SIZE = 256;
const TRAY_SIZES = [16, 24, 32, 48, 64, 128, 256];
const PHI_GLYPH = 'Φ';
const FONT_NAME = 'JetBrains Mono';
// The TBAR's .logo uses font-weight: 600 in web/style.css, but the
// vendored JetBrains Mono woff2's greek subset only defines weights
// 400 and 500; the browser falls back to the closest available weight
// (500, Medium). GDI+ has no Medium/Bold-by-number font style —
// `FontStyle.Bold` is weight 700, which produces a noticeably thicker
// glyph than what the browser renders. So we render at Regular
// (400) and the visual difference vs the browser's 500 is minimal:
// the font's Regular face is closer to the browser's Medium than
// GDI+'s Bold is.
const TBAR_FALLBACK_WEIGHT = 400;

function pickJetBrainsMonoFile() {
  // The greek subset is the one that contains U+03A6 (Phi). Match
  // by reading web/vendor/fonts/fonts.css for the @font-face with
  // unicode-range covering U+0370-03FF; that pins the subset to
  // the same source the browser uses, so the icon glyph is the
  // exact same glyph as the TBAR's .logo.
  const css = readFileSync(path.join(WEB_FONTS_DIR, 'fonts.css'), 'utf8');
  const blocks = css.split(/\}/);
  for (const block of blocks) {
    if (!block.includes('U+0370')) continue;
    const src = block.match(/url\((jetbrainsmono-[0-9a-f]+\.woff2)\)/);
    if (src) return path.join(WEB_FONTS_DIR, src[1]);
  }
  throw new Error('gen-icon: no greek-subset JetBrains Mono woff2 in web/vendor/fonts/fonts.css');
}

async function ensureJetBrainsMonoTtf() {
  const woff2Path = pickJetBrainsMonoFile();
  const woff2Bytes = readFileSync(woff2Path);
  const ttf = await wawoff2.decompress(woff2Bytes);
  writeFileSync(OUT_TTF, Buffer.from(ttf));
  return OUT_TTF;
}

function loadAccentPalette() {
  const src = readFileSync(WEB_APP_JS, 'utf8');
  const match = src.match(/(?:export\s+)?const ACCENT_COLORS\s*=\s*\{([\s\S]*?)\n\};/);
  if (!match) throw new Error('gen-icon: ACCENT_COLORS not found in web/app.js');
  const body = match[1];
  const entries = [];
  const re = /(\w+):\s*\{\s*accent:\s*['"]#([0-9a-fA-F]{6})['"]/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    entries.push({ name: m[1], hex: '#' + m[2].toLowerCase() });
  }
  if (entries.length === 0) throw new Error('gen-icon: no accent entries parsed');
  return entries;
}

/** Renders the Φ glyph at `size` x `size` (RGBA, transparent bg) via
 *  PowerShell + System.Drawing. The master canvas is 1024x1024
 *  (super-sampled for crisp edges at every DPI), then downscaled to
 *  the target size via HighQualityBicubic. */
function renderPhiPng(ttfPath, size, glyphColor) {
  const master = 1024;
  const fontSize = Math.round(master * 0.84); // Φ fills ~70% of the master canvas
  const ps = `
Add-Type -AssemblyName System.Drawing
$ttfPath = '${ttfPath.replaceAll("'", "''")}'
$pf = New-Object System.Drawing.Text.PrivateFontCollection
$pf.AddFontFile($ttfPath)
$fontFamily = $pf.Families | Where-Object { $_.Name -eq '${FONT_NAME}' } | Select-Object -First 1
if (-not $fontFamily) {
  [Console]::Error.WriteLine("font family ${FONT_NAME} not found in $ttfPath")
  exit 1
}
$master = New-Object System.Drawing.Bitmap(${master}, ${master})
$gMaster = [System.Drawing.Graphics]::FromImage($master)
$gMaster.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$gMaster.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$gMaster.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$gMaster.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$gMaster.Clear([System.Drawing.Color]::Transparent)
$font = New-Object System.Drawing.Font($fontFamily, ${fontSize}, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = [System.Drawing.StringAlignment]::Center
$sf.LineAlignment = [System.Drawing.StringAlignment]::Center
$rect = New-Object System.Drawing.RectangleF(0, 0, ${master}, ${master})
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, ${glyphColor[0]}, ${glyphColor[1]}, ${glyphColor[2]}))
$gMaster.DrawString('${PHI_GLYPH}', $font, $brush, $rect, $sf)
$out = New-Object System.Drawing.Bitmap(${size}, ${size})
$gOut = [System.Drawing.Graphics]::FromImage($out)
$gOut.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$gOut.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$gOut.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$gOut.Clear([System.Drawing.Color]::Transparent)
$gOut.DrawImage($master, (New-Object System.Drawing.Rectangle 0, 0, ${size}, ${size}))
$ms = New-Object System.IO.MemoryStream
$out.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
[Console]::OpenStandardOutput().Write($ms.ToArray(), 0, $ms.Length)
$gMaster.Dispose(); $gOut.Dispose(); $master.Dispose(); $out.Dispose(); $font.Dispose(); $brush.Dispose(); $ms.Dispose(); $pf.Dispose()
`;
  const result = spawnSync('powershell', ['-NoProfile', '-Command', ps], {
    encoding: 'buffer',
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`gen-icon: PowerShell render failed: ${result.stderr?.toString()}`);
  }
  return result.stdout;
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function icoFor(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dirSize = 16 * entries.length;
  let dataOffset = 6 + dirSize;
  const dirEntries = [];
  const datas = [];
  for (const e of entries) {
    const d = Buffer.alloc(16);
    d.writeUInt8(e.size >= 256 ? 0 : e.size, 0);
    d.writeUInt8(e.size >= 256 ? 0 : e.size, 1);
    d.writeUInt8(0, 2);
    d.writeUInt8(0, 3);
    d.writeUInt16LE(1, 4);
    d.writeUInt16LE(32, 6);
    d.writeUInt32LE(e.png.length, 8);
    d.writeUInt32LE(dataOffset, 12);
    dirEntries.push(d);
    datas.push(e.png);
    dataOffset += e.png.length;
  }
  return Buffer.concat([header, ...dirEntries, ...datas]);
}

const palette = loadAccentPalette();
mkdirSync(ICONS_DIR, { recursive: true });

const ttfPath = await ensureJetBrainsMonoTtf();
console.log(`decoded ${path.basename(ttfPath)} from web/vendor/fonts/ JetBrains Mono woff2`);

// Application/window icon: white Φ, transparent bg, no halo.
const whiteIcon = renderPhiPng(ttfPath, SIZE, [0xff, 0xff, 0xff]);
writeFileSync(OUT_ICON, whiteIcon);
console.log(`wrote ${OUT_ICON} (${SIZE}x${SIZE}, ${FONT_NAME} Φ)`);

// Per-accent variants: same glyph, accent color, no halo.
const manifest = {};
for (const { name, hex } of palette) {
  const accentRgb = hexToRgb(hex);
  const png = renderPhiPng(ttfPath, SIZE, accentRgb);
  const file = `icon-${name}.png`;
  writeFileSync(path.join(ICONS_DIR, file), png);
  manifest[hex] = file;
}
writeFileSync(path.join(ICONS_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote ${palette.length} accent icons + manifest -> assets/icons/`);

// Tray fallback PNG: 256x256 white glyph, transparent.
const trayPng = renderPhiPng(ttfPath, SIZE, [0xff, 0xff, 0xff]);
writeFileSync(OUT_TRAY_PNG, trayPng);

// Multi-size ICO for the Windows taskbar / Alt-Tab / shortcut overlays
// (used as BrowserWindow's `icon`). Every size is rendered at native
// resolution through GDI+ after super-sampling at 1024x1024, so the
// shell picks the closest pre-rendered layer instead of downscaling a
// single PNG (which is what produces the aliased look on the taskbar).
const icoEntries = TRAY_SIZES.map((size) => ({
  size,
  png: renderPhiPng(ttfPath, size, [0xff, 0xff, 0xff]),
}));
const iconIco = icoFor(icoEntries);
writeFileSync(OUT_ICON_ICO, iconIco);
console.log(`wrote ${OUT_ICON_ICO} (${TRAY_SIZES.join('/')}px, ${FONT_NAME} Φ, taskbar)`);

// Same multi-size ICO for the tray.
writeFileSync(OUT_TRAY_ICO, iconIco);
console.log(`wrote ${OUT_TRAY_ICO} (${TRAY_SIZES.join('/')}px, ${FONT_NAME} Φ, tray)`);
