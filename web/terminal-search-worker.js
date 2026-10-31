import { archiveScrollbackFor, createTerminalArchiveScanner, } from './terminal-search-core.js';
const scope = globalThis;
let job = null;
let commandPending = false;
const parserPromise = (async () => {
    scope.exports = {};
    await import(new URL('./vendor/xterm-headless.js', import.meta.url).href);
    const terminalConstructor = scope.exports?.Terminal;
    if (typeof terminalConstructor !== 'function')
        throw new Error('vendored terminal parser did not load');
    return terminalConstructor;
})();
function bytesOf(value) {
    if (value instanceof ArrayBuffer)
        return new Uint8Array(value);
    if (value instanceof Uint8Array)
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new Error('invalid worker byte view');
}
function disposeJob() {
    if (!job)
        return;
    job.scanner.dispose();
    job = null;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function fail(jobId, error) {
    disposeJob();
    scope.postMessage({ type: 'error', jobId, message: errorMessage(error) });
}
function sendMatches(current) {
    const matches = current.scanner.takeMatches();
    const capped = current.scanner.capped;
    if (matches.length === 0 && capped === current.reportedCapped)
        return;
    current.reportedCapped = capped;
    scope.postMessage({
        type: 'matches',
        jobId: current.id,
        through: current.through,
        matches,
        capped,
    });
}
async function initialize(command) {
    if (!command.jobId || command.jobId.length > 128)
        throw new Error('invalid job identity');
    if (!Number.isSafeInteger(command.through) || command.through < 0)
        throw new Error('invalid checkpoint frontier');
    const scrollback = archiveScrollbackFor(command.cols, command.rows);
    const Terminal = await parserPromise;
    const terminal = new Terminal({
        cols: command.cols,
        rows: command.rows,
        scrollback,
        allowProposedApi: true,
        disableStdin: true,
    });
    const scanner = createTerminalArchiveScanner(terminal, command.query);
    const next = {
        id: command.jobId,
        scanner,
        through: command.through,
        reportedCapped: false,
    };
    job = next;
    await scanner.write(bytesOf(command.bytes));
    scope.postMessage({ type: 'ready', jobId: next.id, through: next.through });
    sendMatches(next);
}
async function applyRange(command) {
    const current = job;
    if (!current || current.id !== command.jobId)
        throw new Error('stale archive-search job');
    const bytes = bytesOf(command.bytes);
    if (!Number.isSafeInteger(command.start) ||
        !Number.isSafeInteger(command.end) ||
        command.start !== current.through ||
        command.end < command.start ||
        command.end - command.start !== bytes.byteLength)
        throw new Error('non-contiguous recording range');
    const markers = command.resizes ?? [];
    let previous = command.start;
    let offset = 0;
    for (const marker of markers) {
        if (!Array.isArray(marker) ||
            marker.length !== 3 ||
            !Number.isSafeInteger(marker[0]) ||
            marker[0] < previous ||
            marker[0] < command.start ||
            marker[0] > command.end)
            throw new Error('invalid resize marker');
        const [at, cols, rows] = marker;
        archiveScrollbackFor(cols, rows);
        await current.scanner.write(bytes.subarray(offset, at - command.start));
        current.scanner.resize(cols, rows);
        offset = at - command.start;
        previous = at;
    }
    await current.scanner.write(bytes.subarray(offset));
    current.through = command.end;
    sendMatches(current);
    scope.postMessage({
        type: 'ack',
        jobId: current.id,
        through: current.through,
    });
}
async function handle(command) {
    if (command.type === 'init') {
        if (job)
            throw new Error('worker already owns an archive-search job');
        await initialize(command);
        return;
    }
    if (command.type === 'range') {
        await applyRange(command);
        return;
    }
    const current = job;
    if (!current || current.id !== command.jobId)
        throw new Error('stale archive-search job');
    current.scanner.finish();
    sendMatches(current);
    scope.postMessage({
        type: 'complete',
        jobId: current.id,
        through: current.through,
    });
    disposeJob();
}
scope.onmessage = (event) => {
    const command = event.data;
    if (commandPending) {
        fail(command?.jobId ?? '', new Error('worker command already pending'));
        return;
    }
    commandPending = true;
    void handle(command)
        .catch((error) => fail(command?.jobId ?? '', error))
        .finally(() => {
        commandPending = false;
    });
};
