/* Φ phi — File-tree viewer dispatcher

   Routes a file-tree entry to the right inline preview viewer. The
   heavy lifting is done by vendored libraries — Viewer.js for images,
   Plyr for video/audio, Chromium's built-in iframe for PDF,
   @alenaksu/json-viewer for JSON, and phi's existing marked/DOMPurify/
   hljs for markdown and code. This module is the thin shell that
   picks which library to mount and the lifecycle for disposing it.

   Server contract: /api/file/asset (api_file.go). Cwd-relative paths
   confined to cwd. Range/HEAD/nosniff handled by http.ServeFile. See
   da53759 for the security model.

   Lifecycle: every viewer returns {dispose()}. Callers MUST call it
   on (a) replacing one viewer with another in the same container
   (stale <video> elements otherwise keep playing audio after the
   swap), and (b) hiding the container. InnerHTML='' alone is not
   enough — Plyr holds an event listener on the media element and
   Viewer.js holds a back-reference on the <img>; .destroy() releases
   both. */

import { renderMarkdownSafe } from './md-render.js';

export interface FileViewHandle {
    dispose(): void;
}

const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i;
const VID_EXT = /\.(mp4|m4v|mov|webm|ogv|mkv)$/i;
const AUD_EXT = /\.(mp3|m4a|ogg|oga|wav|flac|opus)$/i;
const MD_EXT = /\.(md|markdown)$/i;
const JSON_EXT = /\.(jsonc|json5)$/i;

// `language` values for hljs. Source-of-truth list per the vendored
// hljs bundle; extending the dispatcher to a new code language is
// one line here.
const CODE_LANG: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    jsx: 'javascript',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    go: 'go',
    java: 'java',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    hpp: 'cpp',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    fish: 'shell',
    ps1: 'powershell',
    bat: 'batch',
    cmd: 'batch',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'ini',
    ini: 'ini',
    conf: 'ini',
    cfg: 'ini',
    properties: 'ini',
    editorconfig: 'ini',
    sql: 'sql',
    graphql: 'graphql',
    gql: 'graphql',
    css: 'css',
    scss: 'scss',
    less: 'less',
    html: 'xml',
    htm: 'xml',
    xhtml: 'xml',
    xml: 'xml',
    svg: 'xml',
    diff: 'diff',
    patch: 'diff',
    txt: 'plaintext',
    log: 'plaintext',
    csv: 'plaintext',
    tsv: 'plaintext',
    env: 'plaintext',
    dockerfile: 'dockerfile',
    makefile: 'makefile',
};

export function kindFor(ext: string): string {
    const e = ext.toLowerCase();
    if (IMG_EXT.test(e)) return 'image';
    if (VID_EXT.test(e)) return 'video';
    if (AUD_EXT.test(e)) return 'audio';
    if (e === '.pdf') return 'pdf';
    if (MD_EXT.test(e)) return 'markdown';
    if (e === '.json' || JSON_EXT.test(e)) return 'json';
    if (Object.prototype.hasOwnProperty.call(CODE_LANG, e.slice(1)))
        return 'code';
    return 'download';
}

export async function mountFileView(opts: {
    path: string;
    cwd: string;
    container: HTMLElement;
    signal?: AbortSignal;
}): Promise<FileViewHandle> {
    const { path, cwd, container, signal } = opts;
    const url = `/api/file/asset?path=${encodeURIComponent(path)}&cwd=${encodeURIComponent(cwd)}`;
    const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
    const kind = kindFor(ext);

    container.innerHTML = '';
    switch (kind) {
        case 'image':
            return mountImage(url, container);
        case 'video':
            return mountMedia(url, container, true);
        case 'audio':
            return mountMedia(url, container, false);
        case 'pdf':
            return mountPdf(url, container);
        case 'markdown':
            return mountMarkdown(url, container, signal);
        case 'code':
            return mountCode(url, ext, container, signal);
        case 'json':
            return mountJson(url, container, signal);
        case 'download':
            return mountDownload(url, path, container);
        default:
            return mountDownload(url, path, container);
    }
}

function mountImage(url: string, container: HTMLElement): FileViewHandle {
    const img = document.createElement('img');
    img.className = 'file-viewer-image';
    img.src = url;
    img.alt = '';
    img.loading = 'lazy';
    container.appendChild(img);
    // Viewer.js's inline mode keeps the <img> in the modal and exposes
    // zoom/pan/rotate/touch/fullscreen via its built-in toolbar; the
    // user clicks to enter/exit zoomed view. Inline=false so the
    // lightbox uses its own backdrop, which matches phi's modal
    // pattern (the modal itself acts as the backdrop).
    const viewer = new window.Viewer(img, {
        inline: false,
        navbar: false,
        title: false,
        backdrop: true,
    });
    return {
        dispose() {
            try {
                viewer.destroy();
            } catch {
                // Viewer.destroy throws if called twice; that's fine.
            }
            container.innerHTML = '';
        },
    };
}

function mountMedia(
    url: string,
    container: HTMLElement,
    isVideo: boolean,
): FileViewHandle {
    const el = document.createElement(isVideo ? 'video' : 'audio');
    el.className = isVideo ? 'file-viewer-video' : 'file-viewer-audio';
    el.src = url;
    el.preload = 'metadata';
    el.controls = true;
    container.appendChild(el);
    // Plyr's blankVideo defaults to cdn.plyr.io; override with the
    // vendored local copy so the player never reaches a CDN.
    const player = new window.Plyr(el, {
        blankVideo: 'vendor/plyr/blank.mp4',
        // Plyr's fullscreen toggling is on by default; no work needed.
    });
    return {
        dispose() {
            try {
                player.destroy();
            } catch {
                // Player may already be destroyed if the user navigates
                // away mid-playback; that's fine.
            }
            el.pause();
            el.removeAttribute('src');
            // .load() resets the media element so the browser drops any
            // buffered ranges; without this Chromium keeps the audio
            // context alive across modal close.
            el.load();
            container.innerHTML = '';
        },
    };
}

function mountPdf(url: string, container: HTMLElement): FileViewHandle {
    const iframe = document.createElement('iframe');
    iframe.className = 'file-viewer-pdf';
    iframe.src = url;
    iframe.title = 'PDF preview';
    iframe.setAttribute('allow', 'fullscreen');
    container.appendChild(iframe);
    return {
        dispose() {
            // Removing the src stops the iframe's pending PDF download
            // (Chromium's plugin otherwise continues fetching in the
            // background). InnerHTML='' removes the node.
            iframe.removeAttribute('src');
            container.innerHTML = '';
        },
    };
}

async function mountMarkdown(
    url: string,
    container: HTMLElement,
    signal: AbortSignal | undefined,
): Promise<FileViewHandle> {
    container.innerHTML = '<div class="md-rendering">Loading…</div>';
    const res = await fetch(url, { signal });
    if (!res.ok)
        throw new Error(`Failed to load (${res.status} ${res.statusText})`);
    const text = await res.text();
    container.innerHTML = `<div class="md-rendered">${renderMarkdownSafe(text)}</div>`;
    return { dispose: () => { container.innerHTML = ''; } };
}

async function mountCode(
    url: string,
    ext: string,
    container: HTMLElement,
    signal: AbortSignal | undefined,
): Promise<FileViewHandle> {
    const lang = CODE_LANG[ext.slice(1)] || 'plaintext';
    container.innerHTML = '<div class="md-rendering">Loading…</div>';
    const res = await fetch(url, { signal });
    if (!res.ok)
        throw new Error(`Failed to load (${res.status} ${res.statusText})`);
    const text = await res.text();
    // textContent (NOT innerHTML) — the file may contain HTML-looking
    // snippets that must render literally, not as markup.
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.className = `hljs language-${lang}`;
    code.textContent = text;
    pre.appendChild(code);
    container.innerHTML = '';
    container.appendChild(pre);
    if (window.hljs) window.hljs.highlightElement(code);
    return { dispose: () => { container.innerHTML = ''; } };
}

async function mountJson(
    url: string,
    container: HTMLElement,
    signal: AbortSignal | undefined,
): Promise<FileViewHandle> {
    container.innerHTML = '<div class="md-rendering">Loading…</div>';
    const res = await fetch(url, { signal });
    if (!res.ok)
        throw new Error(`Failed to load (${res.status} ${res.statusText})`);
    const text = await res.text();
    // Try strict JSON first; json5/jsonc fall through to a raw text
    // view since alenaksu/json-viewer expects valid JSON.
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        parsed = undefined;
    }
    const el = document.createElement('json-viewer');
    el.className = 'file-viewer-json';
    if (parsed !== undefined) {
        // .data setter is the documented API; assigning parsed values
        // circumvents innerHTML and any prototype-pollution surface
        // from a crafted JSON key like `__proto__`.
        (el as unknown as { data: unknown }).data = parsed;
    } else {
        // Invalid JSON: render the raw text as a code block.
        el.textContent = text;
    }
    container.innerHTML = '';
    container.appendChild(el);
    return { dispose: () => { container.innerHTML = ''; } };
}

function mountDownload(url: string, path: string, container: HTMLElement): FileViewHandle {
    const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
    container.innerHTML =
        `<div class="file-viewer-download">` +
        `<p>Can't preview <code>${escapeHtml(name)}</code>.</p>` +
        `<a class="file-viewer-download-btn" href="${escapeHtml(url)}" download="${escapeHtml(name)}">Download</a>` +
        `</div>`;
    return { dispose: () => { container.innerHTML = ''; } };
}

function escapeHtml(s: string): string {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
