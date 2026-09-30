/* Φ phi — VS Code launch URI builders (browser-only)
 *
 * Builds `vscode://` URIs that the browser hands to the OS via a native
 * <a href> click. No fetch, no service worker, no browser extension.
 * VS Code's protocol handler is responsible for resolving them.
 *
 * Local: vscode://file/<absolute-posix-or-windows-path>
 * Remote: vscode://vscode-remote/ssh-remote+<hostname>/<absolute-path>
 *
 * Three rules govern both builders (Plan 1 §4, Plan 2 §5):
 *   1. Reject anything that isn't a clean absolute path. No traversal,
 *      no NUL, no absolute row paths, no unsupported UNC.
 *   2. Encode path segments exactly once. Spaces, Unicode, %, #, ?, and
 *      filename colons all pass through encodeURIComponent. The leading
 *      POSIX slash and Windows drive colon survive unchanged.
 *   3. Distinguish file from folder for remote URIs by the trailing
 *      `:1:1` line suffix. Without it, VS Code opens a plain remote path
 *      as a folder — even when it names a file.
 */
const TRAVERSAL_SEGMENT = /(^|\/)\.\.(\/|$)/;
// ----------------------------------------------------------------------------
// Local builder
// ----------------------------------------------------------------------------
/** Returns true when `value` looks like a Windows drive path
 *  (e.g. `C:/foo`, `C:\foo`, `Z:\Users\alex`). Case-insensitive on the
 *  drive letter, since Windows itself is case-insensitive for that. */
export function isWindowsDrivePath(value) {
    return /^[A-Za-z]:[\\/]/.test(value);
}
/** Splits a POSIX or Windows absolute path into segments that should
 *  each be URI-encoded exactly once. The Windows drive letter + colon
 *  is preserved verbatim; POSIX paths carry no head (the URI's leading
 *  `/` after the scheme stands in for it). Windows separators are
 *  normalized to forward slashes only when the input is a Windows
 *  drive path — a POSIX backslash is part of a filename. */
export function splitPathSegments(absolute) {
    if (!absolute || typeof absolute !== 'string')
        return null;
    if (absolute.includes('\0'))
        return null;
    if (isWindowsDrivePath(absolute)) {
        const drive = absolute.slice(0, 2); // "C:"
        const rest = absolute.slice(2).replace(/\\/g, '/').replace(/^\/+/, '');
        if (rest.includes('\0'))
            return null;
        const segments = rest.length ? rest.split('/') : [];
        return { head: drive, segments };
    }
    if (!absolute.startsWith('/'))
        return null;
    // POSIX path: trailing slashes contribute empty segments that we
    // strip here; the encoding stage handles emptiness as a no-op.
    const trimmed = absolute.replace(/\/+$/, '');
    const segments = trimmed.slice(1).length ? trimmed.slice(1).split('/') : [];
    return { head: '', segments };
}
/** Reject any relative component, NUL, or `..` traversal. Empty segments
 *  collapse into "no segment" — they're legal at the tail. A backslash
 *  is allowed because it can be a literal character in a POSIX filename;
 *  it gets URI-encoded by the builder. */
function isSafeRelative(rel) {
    if (rel === undefined || rel === null)
        return true;
    if (typeof rel !== 'string')
        return false;
    if (rel === '')
        return true;
    if (rel.includes('\0'))
        return false;
    if (rel.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rel))
        return false;
    if (TRAVERSAL_SEGMENT.test(`/${rel}`))
        return false;
    return true;
}
/** Encodes a single path segment exactly once with encodeURIComponent
 *  semantics, preserving characters VS Code cares about. encodeURIComponent
 *  already encodes the dangerous set (spaces, Unicode, %, #, ?, quotes,
 *  colons); reapplying it would double-encode. */
function encodeSegment(seg) {
    if (seg === '')
        return '';
    return encodeURIComponent(seg);
}
/** Builds a `vscode://file/...` URI for `root`, optionally joined with a
 *  relative path under that root. Returns null when the inputs are
 *  rejected (relative root, traversal, NUL, /dev/null, unsupported UNC).
 *
 *  Examples:
 *    buildVSCodeURI('/Users/alex/code/phi')
 *      -> 'vscode://file/Users/alex/code/phi'
 *    buildVSCodeURI('/Users/alex/code/my project', 'src/main.go')
 *      -> 'vscode://file/Users/alex/code/my%20project/src/main.go'
 *    buildVSCodeURI('C:\\Users\\alex\\phi', 'src/main.go')
 *      -> 'vscode://file/C:/Users/alex/phi/src/main.go'
 */
export function buildVSCodeURI(root, relativePath) {
    if (!root || typeof root !== 'string')
        return null;
    if (root.startsWith('//'))
        return null; // UNC — unsupported in Phase 1
    if (root === '/dev/null')
        return null;
    if (!isSafeRelative(relativePath))
        return null;
    const split = splitPathSegments(root);
    if (!split)
        return null;
    const encoded = split.segments.map(encodeSegment).join('/');
    const tail = relativePath
        ? relativePath
            .split('/')
            .map((seg) => (seg === '' ? '' : encodeSegment(seg)))
            .join('/')
        : '';
    const body = [encoded, tail].filter((s) => s.length > 0).join('/');
    // Head carries the Windows drive (`C:`); POSIX paths have an empty
    // head and the scheme's `/` stands in for the leading slash.
    const prefix = split.head.length ? `${split.head}/` : '';
    return `vscode://file/${prefix}${body}`;
}
// ----------------------------------------------------------------------------
// Hostname source: /api/config response's `data.hostname`.
// Existing app.js already mirrors it to `app.hostname`. We never reach
// into DOM strings or location.* — those strip suffixes for display.
// ----------------------------------------------------------------------------
const HOSTNAME_OK = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Normalizes the Phi server hostname for use as an SSH target. Strips
 *  surrounding whitespace, uppercases the trailing suffix... no wait —
 *  lowercase. `JUPITER` -> `jupiter`. Preserves dots, hyphens, and
 *  underscores; rejects anything with a slash, at sign, colon, etc. */
export function normalizeHostname(raw) {
    if (raw === null || raw === undefined)
        return '';
    const trimmed = String(raw).trim().toLowerCase();
    if (!trimmed)
        return '';
    if (!HOSTNAME_OK.test(trimmed))
        return '';
    return trimmed;
}
/** Returns true when the active render target cannot dispatch
 *  `vscode:` URIs. The desktop main view's external-navigation handlers
 *  deny them; embedded Electron must hide the action. */
export function isVSCodeLaunchUnsupported() {
    if (typeof document === 'undefined')
        return false;
    if (document.documentElement.hasAttribute('data-phi-desktop-root'))
        return true;
    if (document.documentElement.hasAttribute('data-phi-desktop'))
        return true;
    if (new URLSearchParams(location.search).get('desktop') === '1')
        return true;
    if (typeof window !== 'undefined' &&
        window.__phiDesktop)
        return true;
    return false;
}
// ----------------------------------------------------------------------------
// Remote builder
// ----------------------------------------------------------------------------
/** Builds a `vscode://vscode-remote/ssh-remote+<host>/<path>` URI.
 *  Appends `:1:1` for files so VS Code's protocol handler opens the file
 *  rather than treating the path as a folder. Folders pass through
 *  without any line suffix.
 *
 *  Rejects Windows drive paths, UNC paths, missing or invalid hostnames,
 *  and the same traversal set as the local builder. */
export function buildVSCodeRemoteURI(hostname, target) {
    const host = normalizeHostname(hostname);
    if (!host)
        return null;
    if (!target || typeof target !== 'object')
        return null;
    const { root, relativePath, kind } = target;
    if (kind !== 'file' && kind !== 'folder')
        return null;
    if (!root || typeof root !== 'string')
        return null;
    // Remote Windows / UNC paths are explicitly unsupported in this phase.
    if (isWindowsDrivePath(root))
        return null;
    if (root.startsWith('//'))
        return null;
    if (root === '/dev/null')
        return null;
    if (!isSafeRelative(relativePath))
        return null;
    const split = splitPathSegments(root);
    if (!split?.head && split?.head !== '')
        return null; // remote = POSIX only
    const encoded = split.segments.map(encodeSegment).join('/');
    const tail = relativePath
        ? relativePath
            .split('/')
            .map((seg) => (seg === '' ? '' : encodeSegment(seg)))
            .join('/')
        : '';
    const body = [encoded, tail].filter((s) => s.length > 0).join('/');
    // Remote = POSIX only (head is empty); the leading `/` after the
    // host separator is the path root.
    const pathPart = body.length ? `/${body}` : '/';
    // Append line suffix after URI encoding the path so a literal
    // filename colon (encoded as %3A) never collides with the
    // structural `:1:1` marker.
    const lineSuffix = kind === 'file' ? ':1:1' : '';
    return `vscode://vscode-remote/ssh-remote+${host}${pathPart}${lineSuffix}`;
}
