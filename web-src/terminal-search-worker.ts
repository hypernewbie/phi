import type {
    ITerminalInitOnlyOptions,
    ITerminalOptions,
    Terminal as HeadlessTerminal,
} from '@xterm/headless';
import {
    archiveScrollbackFor,
    createTerminalArchiveScanner,
    type TerminalArchiveMatch,
    type TerminalArchiveScanner,
} from './terminal-search-core.js';

type TerminalConstructor = new (
    options: ITerminalOptions & ITerminalInitOnlyOptions,
) => HeadlessTerminal;
type WorkerBytes = ArrayBuffer | Uint8Array;
type ResizeMarker = readonly [at: number, cols: number, rows: number];
type InitCommand = {
    type: 'init';
    jobId: string;
    query: string;
    through: number;
    cols: number;
    rows: number;
    bytes: WorkerBytes;
};
type RangeCommand = {
    type: 'range';
    jobId: string;
    start: number;
    end: number;
    bytes: WorkerBytes;
    resizes?: ResizeMarker[];
};
type FinishCommand = { type: 'finish'; jobId: string };
type WorkerCommand = InitCommand | RangeCommand | FinishCommand;
type WorkerReply =
    | { type: 'ready'; jobId: string; through: number }
    | { type: 'ack'; jobId: string; through: number }
    | {
          type: 'matches';
          jobId: string;
          through: number;
          matches: TerminalArchiveMatch[];
          capped: boolean;
      }
    | { type: 'complete'; jobId: string; through: number }
    | { type: 'error'; jobId: string; message: string };
type WorkerScope = {
    exports?: { Terminal?: unknown };
    onmessage: ((event: MessageEvent<WorkerCommand>) => void) | null;
    postMessage(message: WorkerReply): void;
};
type SearchJob = {
    id: string;
    scanner: TerminalArchiveScanner;
    through: number;
    reportedCapped: boolean;
};

const scope = globalThis as unknown as WorkerScope;
let job: SearchJob | null = null;
let commandPending = false;

const parserPromise = (async (): Promise<TerminalConstructor> => {
    scope.exports = {};
    await import(new URL('./vendor/xterm-headless.js', import.meta.url).href);
    const terminalConstructor = scope.exports?.Terminal;
    if (typeof terminalConstructor !== 'function')
        throw new Error('vendored terminal parser did not load');
    return terminalConstructor as TerminalConstructor;
})();

function bytesOf(value: WorkerBytes): Uint8Array {
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (value instanceof Uint8Array)
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new Error('invalid worker byte view');
}

function disposeJob(): void {
    if (!job) return;
    job.scanner.dispose();
    job = null;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function fail(jobId: string, error: unknown): void {
    disposeJob();
    scope.postMessage({ type: 'error', jobId, message: errorMessage(error) });
}

function sendMatches(current: SearchJob): void {
    const matches = current.scanner.takeMatches();
    const capped = current.scanner.capped;
    if (matches.length === 0 && capped === current.reportedCapped) return;
    current.reportedCapped = capped;
    scope.postMessage({
        type: 'matches',
        jobId: current.id,
        through: current.through,
        matches,
        capped,
    });
}

async function initialize(command: InitCommand): Promise<void> {
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

async function applyRange(command: RangeCommand): Promise<void> {
    const current = job;
    if (!current || current.id !== command.jobId)
        throw new Error('stale archive-search job');
    const bytes = bytesOf(command.bytes);
    if (
        !Number.isSafeInteger(command.start) ||
        !Number.isSafeInteger(command.end) ||
        command.start !== current.through ||
        command.end < command.start ||
        command.end - command.start !== bytes.byteLength
    )
        throw new Error('non-contiguous recording range');
    const markers = command.resizes ?? [];
    let previous = command.start;
    let offset = 0;
    for (const marker of markers) {
        if (
            !Array.isArray(marker) ||
            marker.length !== 3 ||
            !Number.isSafeInteger(marker[0]) ||
            marker[0] < previous ||
            marker[0] < command.start ||
            marker[0] > command.end
        )
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

async function handle(command: WorkerCommand): Promise<void> {
    if (command.type === 'init') {
        if (job) throw new Error('worker already owns an archive-search job');
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
        .catch((error: unknown) => fail(command?.jobId ?? '', error))
        .finally(() => {
            commandPending = false;
        });
};
