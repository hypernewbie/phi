import { escapeHtml } from './util.js';
// Shared DOMPurify policy for untrusted HTML. Callers must check
// window.DOMPurify?.sanitize first and pick their own fallback.
export function sanitizeHtml(html) {
    return String(window.DOMPurify.sanitize(html, {
        USE_PROFILES: { html: true },
        FORBID_TAGS: [
            'script',
            'style',
            'iframe',
            'object',
            'embed',
            'form',
        ],
        FORBID_ATTR: ['style'],
    }));
}
// Renders markdown to HTML and sanitizes it. Every innerHTML sink for
// markdown-derived content must go through this — .md files and agent
// output are untrusted.
export function renderMarkdownSafe(raw) {
    if (raw == null || raw === '')
        return '';
    if (!window.marked || !window.DOMPurify?.sanitize) {
        return `<pre>${escapeHtml(raw)}</pre>`;
    }
    return sanitizeHtml(String(window.marked.parse(raw)));
}
// Collapses ./ and ../ segments; baseDir and rel use forward slashes.
export function resolveRelative(baseDir, rel) {
    const stack = baseDir.split('/').filter(Boolean);
    for (const seg of rel.split('/')) {
        if (!seg || seg === '.')
            continue;
        if (seg === '..') {
            stack.pop();
            continue;
        }
        stack.push(seg);
    }
    return '/' + stack.join('/');
}
// Rewrites relative <img> srcs to the asset endpoint, resolved against
// the markdown file's directory. Absolute URLs (scheme, //, /, #, data:)
// are left untouched.
export function rewriteRelativeImages(container, mdPath, cwd) {
    // Windows-aware: server paths may use backslashes (filepath.Join).
    const cut = Math.max(mdPath.lastIndexOf('/'), mdPath.lastIndexOf('\\'));
    const baseDir = cut > 0 ? mdPath.slice(0, cut).replace(/\\/g, '/') : '';
    container.querySelectorAll('img').forEach((img) => {
        const src = img.getAttribute('src'); // NOT img.src — the property returns the resolved absolute URL
        if (!src || /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(src))
            return;
        const clean = src.replace(/[?#].*$/, ''); // img.png?v=2 → img.png
        const abs = resolveRelative(baseDir, clean);
        img.setAttribute('src', `/api/markdown/asset?path=${encodeURIComponent(abs)}&cwd=${encodeURIComponent(cwd)}`);
    });
}
// Applies hljs syntax highlighting to the fenced code blocks inside el.
export function highlightCodeIn(el) {
    if (!window.hljs)
        return;
    el.querySelectorAll('pre code').forEach((block) => {
        window.hljs.highlightElement(block);
    });
}
