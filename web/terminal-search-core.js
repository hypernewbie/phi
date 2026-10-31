const MAX_PARSER_CELLS = 4_000_000;
const MAX_SCROLLBACK_ROWS = 10_000;
const MAX_QUERY_CODE_POINTS = 256;
const MAX_QUERY_BYTES = 1024;
const MAX_SNIPPET_BYTES = 2048;
const MAX_PENDING_LINE_BYTES = 16 * 1024;
const MAX_WRITE_BYTES = 4096;
const encoder = new TextEncoder();
export function archiveScrollbackFor(cols, rows) {
    if (!Number.isSafeInteger(cols) ||
        !Number.isSafeInteger(rows) ||
        cols < 1 ||
        rows < 1 ||
        cols > 65_535 ||
        rows > 65_535)
        throw new Error('invalid parser geometry');
    const budget = Math.floor(MAX_PARSER_CELLS / cols) - 2 * rows;
    if (budget < 1)
        throw new Error('parser geometry exceeds cell budget');
    return Math.min(MAX_SCROLLBACK_ROWS, budget);
}
function tailWithinBytes(text, maxBytes) {
    const points = Array.from(text);
    let bytes = 0;
    let start = points.length;
    while (start > 0) {
        const next = encoder.encode(points[start - 1]).byteLength;
        if (bytes + next > maxBytes)
            break;
        bytes += next;
        start--;
    }
    return points.slice(start).join('');
}
function matchingSnippet(text, query, pattern) {
    const match = pattern.exec(text);
    if (!match)
        return null;
    if (encoder.encode(text).byteLength <= MAX_SNIPPET_BYTES)
        return text;
    const startPoint = Array.from(text.slice(0, match.index)).length;
    const points = Array.from(text);
    const matchPoints = Array.from(match[0]).length;
    const start = Math.max(0, startPoint - 64);
    const end = Math.min(points.length, startPoint + matchPoints + 128);
    const snippet = points.slice(start, end).join('');
    return encoder.encode(snippet).byteLength <= MAX_SNIPPET_BYTES
        ? snippet
        : query;
}
function lineText(line) {
    return line?.translateToString(true) ?? '';
}
export function createTerminalArchiveScanner(terminal, query) {
    if (Array.from(query).length > MAX_QUERY_CODE_POINTS ||
        encoder.encode(query).byteLength > MAX_QUERY_BYTES)
        throw new Error('invalid search query');
    const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
    const markerIds = new WeakMap();
    const fallbackRows = new Map();
    const results = new Map();
    const reported = new Set();
    const dirtyRows = new Set();
    let nextId = 1;
    let pending = null;
    let capped = false;
    let disposed = false;
    let lastFallbackType = terminal.buffer.active.type;
    let lastFallbackBase = terminal.buffer.active.baseY;
    const identity = (marker, row) => {
        if (marker) {
            let id = markerIds.get(marker);
            if (id === undefined) {
                id = nextId++;
                markerIds.set(marker, id);
            }
            return id;
        }
        const buffer = terminal.buffer.active;
        if (buffer.type !== lastFallbackType ||
            buffer.baseY !== lastFallbackBase) {
            fallbackRows.clear();
            lastFallbackType = buffer.type;
            lastFallbackBase = buffer.baseY;
        }
        let id = fallbackRows.get(row);
        if (id === undefined) {
            id = nextId++;
            fallbackRows.set(row, id);
        }
        return id;
    };
    const recordMatch = (id, text) => {
        if (results.has(id))
            return;
        const snippet = matchingSnippet(text, query, pattern);
        if (snippet === null)
            return;
        if (results.size >= 200) {
            capped = true;
            return;
        }
        results.set(id, { id, snippet });
    };
    const acceptLine = (id, text, wrapped) => {
        if (wrapped && pending) {
            pending.text = tailWithinBytes(`${pending.text}${text}`, MAX_PENDING_LINE_BYTES);
            recordMatch(pending.id, pending.text);
            return;
        }
        pending = { id, text: tailWithinBytes(text, MAX_PENDING_LINE_BYTES) };
        recordMatch(pending.id, pending.text);
    };
    const observeLineFeed = () => {
        const buffer = terminal.buffer.active;
        const index = buffer.baseY + buffer.cursorY - 1;
        const line = buffer.getLine(index);
        const marker = buffer.type === 'normal' ? terminal.registerMarker(-1) : undefined;
        const id = identity(marker, index);
        acceptLine(id, lineText(line), line?.isWrapped === true);
    };
    const inspectRenderedRows = (allRows = false) => {
        if (disposed)
            return;
        const buffer = terminal.buffer.active;
        const screenStart = buffer.viewportY;
        const screenEnd = Math.min(buffer.length, screenStart + terminal.rows);
        if (allRows) {
            for (let row = 0; row < terminal.rows; row++)
                dirtyRows.add(row);
        }
        dirtyRows.add(Math.max(0, Math.min(terminal.rows - 1, buffer.cursorY)));
        const changed = Array.from(dirtyRows).sort((a, b) => a - b);
        dirtyRows.clear();
        if (changed.length === 0)
            return;
        const markersByLine = new Map();
        if (buffer.type === 'normal') {
            for (const marker of terminal.markers) {
                if (!marker.isDisposed)
                    markersByLine.set(marker.line, marker);
            }
        }
        let coveredThrough = -1;
        for (const screenRow of changed) {
            const row = screenStart + screenRow;
            if (row < screenStart || row >= screenEnd || row <= coveredThrough)
                continue;
            let first = row;
            while (first > 0 && buffer.getLine(first)?.isWrapped)
                first--;
            // The parser can evict the start of a long wrapped row. Search the
            // available tail instead of discarding the whole logical line.
            let last = row;
            while (last + 1 < buffer.length &&
                buffer.getLine(last + 1)?.isWrapped)
                last++;
            coveredThrough = last;
            const pieces = [];
            for (let index = first; index <= last; index++)
                pieces.push(lineText(buffer.getLine(index)));
            const text = tailWithinBytes(pieces.join(''), MAX_PENDING_LINE_BYTES);
            const cursorLine = buffer.baseY + buffer.cursorY;
            let marker = markersByLine.get(first);
            if (!marker && buffer.type === 'normal') {
                marker = terminal.registerMarker(first - cursorLine);
                if (marker)
                    markersByLine.set(first, marker);
            }
            const id = identity(marker, first);
            recordMatch(id, text);
        }
    };
    const lineFeed = terminal.onLineFeed(observeLineFeed);
    const render = terminal.onRender(({ start, end }) => {
        const lower = Math.max(0, start);
        const upper = Math.min(terminal.rows - 1, end);
        for (let row = lower; row <= upper; row++)
            dirtyRows.add(row);
    });
    return {
        async write(bytes) {
            if (disposed)
                throw new Error('archive scanner disposed');
            for (let offset = 0; offset < bytes.byteLength; offset += MAX_WRITE_BYTES) {
                const chunk = bytes.subarray(offset, Math.min(offset + MAX_WRITE_BYTES, bytes.byteLength));
                await new Promise((resolve) => terminal.write(chunk, resolve));
                inspectRenderedRows();
            }
        },
        resize(cols, rows) {
            if (disposed)
                throw new Error('archive scanner disposed');
            terminal.options.scrollback = archiveScrollbackFor(cols, rows);
            terminal.resize(cols, rows);
            inspectRenderedRows(true);
        },
        takeMatches() {
            const fresh = Array.from(results.values())
                .filter((match) => !reported.has(match.id))
                .sort((a, b) => a.id - b.id);
            for (const match of fresh)
                reported.add(match.id);
            return fresh;
        },
        finish() {
            inspectRenderedRows(true);
            if (pending)
                recordMatch(pending.id, pending.text);
        },
        dispose() {
            if (disposed)
                return;
            disposed = true;
            lineFeed.dispose();
            render.dispose();
            results.clear();
            reported.clear();
            fallbackRows.clear();
        },
        get capped() {
            return capped;
        },
    };
}
