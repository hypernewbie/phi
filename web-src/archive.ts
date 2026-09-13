/* Φ phi — Recording archive worker harness (see temp/TERMPERF.md) */

// Spawns the headless recording worker and routes parsed row blocks back
// to the caller. The history UI hands chunks in seq order along with the
// marker set from HistoryStore.getMarkers; the worker replies with
// immutable row blocks that the main thread appends to its archive view.
//
// Why a worker: the parsing load (potentially multi-MiB of history split
// across thousands of resize events) stays off the main thread, so the
// live terminal — running 50/100ms fits every keystroke — never has to
// yield to archive work.

export interface ParseChunk {
    start: number;
    end: number;
    bytes: Uint8Array | ArrayBuffer | string;
}

export interface ResizeMarker {
    AtSeq: number;
    Cols: number;
    Rows: number;
}

export interface ParsedBlock {
    start: number;
    end: number;
    lines: string[];
}

export interface ParseJob {
    paneId: string;
    cols: number;
    rows: number;
    chunks: ParseChunk[];
    markers?: ResizeMarker[];
    /** How many bytes to write between yields inside the worker. */
    yieldEvery?: number;
}

export interface ParseCallbacks {
    onRows?: (paneId: string, blocks: ParsedBlock[]) => void;
    onError?: (paneId: string, message: string) => void;
    onDone?: (paneId: string, lines: number) => void;
}

export interface ParseHandle {
    cancel: () => void;
}

export function startArchiveWorker(
    jobs: ParseJob[],
    callbacks: ParseCallbacks,
): ParseHandle {
    let worker: Worker;
    try {
        worker = new Worker('history-worker.js');
    } catch (e) {
        for (const job of jobs) callbacks.onError?.(job.paneId, String(e));
        return { cancel: () => {} };
    }
    let cancelled = false;
    worker.onmessage = (event: MessageEvent) => {
        if (cancelled) return;
        const m = event.data;
        if (!m || typeof m !== 'object') return;
        switch (m.type) {
            case 'rows':
                callbacks.onRows?.(m.paneId, m.blocks || []);
                break;
            case 'error':
                callbacks.onError?.(m.paneId, m.message || 'unknown');
                break;
            case 'done':
                callbacks.onDone?.(m.paneId, m.lines || 0);
                break;
        }
    };
    worker.onerror = (event: ErrorEvent) => {
        if (cancelled) return;
        const message = event.message || 'worker error';
        for (const job of jobs) callbacks.onError?.(job.paneId, message);
    };

    // Workers only get serializable messages; pre-flush the byte buffers
    // and post one parse job per pane so the worker can keep moving
    // without waiting for anything else on the main thread.
    for (const job of jobs) {
        const transfer: Transferable[] = [];
        const wireChunks = job.chunks.map((c) => {
            if (typeof c.bytes === 'string') return c;
            if (c.bytes instanceof ArrayBuffer) {
                transfer.push(c.bytes);
                return { start: c.start, end: c.end, bytes: c.bytes };
            }
            if (ArrayBuffer.isView(c.bytes)) {
                // Copy into a fresh ArrayBuffer the worker owns: cloning
                // avoids multiple transfer of the same buffer.
                const copy = c.bytes.slice().buffer;
                transfer.push(copy);
                return {
                    start: c.start,
                    end: c.end,
                    bytes: copy,
                };
            }
            return c;
        });
        const message = {
            type: 'parse',
            paneId: job.paneId,
            cols: job.cols,
            rows: job.rows,
            chunks: wireChunks,
            markers: (job.markers || []).map((m) => [m.AtSeq, m.Cols, m.Rows]),
            yieldEvery: job.yieldEvery ?? 64 * 1024,
        };
        try {
            worker.postMessage(message, transfer);
        } catch (e) {
            callbacks.onError?.(job.paneId, String(e));
            // Non-fatal: the next job can still be sent.
        }
    }

    return {
        cancel: () => {
            cancelled = true;
            try {
                worker.terminate();
            } catch (_e) {}
        },
    };
}
