/* Φ phi — Recording archive parser core (see temp/TERMPERF.md) */

// Pure parser the headless worker calls via `importScripts`. Loaded
// as a sibling module so the same parse logic runs from the worker
// AND from main-thread unit tests via a vm shim.
//
// Resize-marker semantics (intentionally approximate):
//   - A marker with AtSeq <= chunk.end is applied BEFORE the chunk's
//     bytes are written. We do not have byte-level sequence
//     information inside a single server chunk, so a marker strictly
//     inside `[chunk.start, chunk.end)` is treated as if it had taken
//     effect at chunk start — the few following bytes render under
//     the new geometry. Visually accurate enough for archive viewing
//     on a per-chunk (256 KiB) granularity.
//
// Row snapshot semantics:
//   - Each chunk reads `term.buffer.normal` after write completes and
//     emits only NEW lines added since the previous chunk. A
//     scrollback evict resets the cursor, so we conservatively emit
//     the whole visible buffer in that case (the next chunk's slice
//     will compensate via the same reset).

async function runArchiveParseCore(job, xtermClasses, callbacks) {
    const Terminal = xtermClasses?.Terminal;
    if (!Terminal) {
        callbacks.onError?.(job.paneId, 'xterm-headless Terminal unavailable');
        callbacks.onDone?.(job.paneId, 0);
        return;
    }
    if (
        !job.cols ||
        !job.rows ||
        !Array.isArray(job.chunks) ||
        job.chunks.length === 0
    ) {
        callbacks.onError?.(job.paneId, 'invalid parse job');
        callbacks.onDone?.(job.paneId, 0);
        return;
    }

    const sortedMarkers = [...(job.markers || [])].sort(
        (a, b) => (a[0] ?? a.AtSeq) - (b[0] ?? b.AtSeq),
    );
    let mi = 0;
    function drainUpTo(targetSeq) {
        while (
            mi < sortedMarkers.length &&
            (sortedMarkers[mi][0] ?? sortedMarkers[mi].AtSeq) <= targetSeq
        ) {
            const m = sortedMarkers[mi];
            const seq = m[0] ?? m.AtSeq;
            const cols = m[1] ?? m.Cols;
            const rows = m[2] ?? m.Rows;
            if (cols && rows) {
                try {
                    term.resize(Math.max(2, cols), Math.max(1, rows));
                } catch (e) {
                    callbacks.onError?.(
                        job.paneId,
                        `resize error at seq ${seq}: ${e.message || e}`,
                    );
                }
            }
            mi++;
        }
    }

    let term;
    try {
        // Scrollback is set generously high so the chunks the archive
        // worker parses (each ≤ 256 KiB) do not evict rows from
        // `buffer.normal` between two consecutive parses. We track
        // ABSOLUTE cursor position (`baseY + cursorY`) and read rows
        // by their absolute index; if those indices have not been
        // evicted, the same logical line survives even after the
        // visible window scrolled.
        term = new Terminal({
            cols: job.cols,
            rows: job.rows,
            scrollback: 100000,
            allowProposedApi: true,
        });
    } catch (e) {
        callbacks.onError?.(
            job.paneId,
            `terminal construction: ${e.message || e}`,
        );
        callbacks.onDone?.(job.paneId, 0);
        return;
    }

    const blocks = [];
    const yieldEvery = job.yieldEvery ?? 64 * 1024;
    let parsedLines = 0;
    let prevAbsCursor = 0;

    function absoluteCursorOf() {
        // Headless's `cursorY` is viewport-relative (0..rows-1) and a
        // long-running chunk can scroll the cursor off the visible
        // window without `cursorY` advancing beyond rows-1. The
        // viewport's ybase tracks the absolute scroll offset; their
        // sum is the absolute line index, monotonic per newline and
        // survives screen scrolling.
        return term.buffer.normal.baseY + term.buffer.normal.cursorY;
    }

    try {
        for (const ch of job.chunks) {
            const startSeq = ch.start;
            const endSeq = ch.end;

            // Every marker whose AtSeq is at or before the END of this
            // chunk applies (by approximation) before the chunk's bytes
            // are written — see the module doc.
            drainUpTo(endSeq);

            let bytes = bytesFrom(ch);
            if (!bytes) continue;

            const beforeAbs = absoluteCursorOf();
            await new Promise((resolve, reject) => {
                try {
                    term.write(bytes, () => resolve());
                } catch (e) {
                    reject(e);
                }
            });
            const afterAbs = absoluteCursorOf();
            const linesAdded = afterAbs - beforeAbs;

            // Tail-slice the buffer for the rows this chunk just wrote.
            // They live at absolute indices `[beforeAbs, afterAbs)`.
            // If scrollback eviction already happened we yield the rows
            // that ARE still available, biased toward the tail (most
            // recent output).
            const available = term.buffer.normal.length;
            const cap = Math.max(0, available - beforeAbs);
            const sliceLen = Math.min(linesAdded, cap);
            const lines = [];
            for (let i = 0; i < sliceLen; i++) {
                const line = term.buffer.normal.getLine(beforeAbs + i);
                const text = line ? line.translateToString(true) : '';
                // Drop a leading empty row (cursor-overwrite artifact)
                // so the archive doesn't grow a whitespace row per chunk.
                if (lines.length === 0 && text.length === 0) continue;
                lines.push(text);
            }
            blocks.push({ start: startSeq, end: endSeq, lines });
            parsedLines += lines.length;

            if (parsedLines > 0 && parsedLines % (yieldEvery / 64) < 1) {
                await new Promise((r) => setTimeout(r, 0));
            }
        }

        // Markers past the last chunk are rare (the archive window
        // covers them) but we honor them so the contract holds.
        drainUpTo(Number.POSITIVE_INFINITY);

        callbacks.onRows?.(job.paneId, blocks);
        callbacks.onDone?.(job.paneId, parsedLines);
    } catch (e) {
        callbacks.onError?.(job.paneId, `parse error: ${e.message || e}`);
        callbacks.onDone?.(job.paneId, parsedLines);
    }
}

if (typeof self !== 'undefined') {
    self.runArchiveParseCore = runArchiveParseCore;
}
if (typeof globalThis !== 'undefined') {
    globalThis.runArchiveParseCore = runArchiveParseCore;
}

function bytesFrom(ch) {
    if (!ch) return '';
    if (typeof ch.bytes === 'string') return ch.bytes;
    if (ch.bytes instanceof ArrayBuffer) return new Uint8Array(ch.bytes);
    if (ArrayBuffer.isView(ch.bytes))
        return new Uint8Array(
            ch.bytes.buffer,
            ch.bytes.byteOffset,
            ch.bytes.byteLength,
        );
    return '';
}
