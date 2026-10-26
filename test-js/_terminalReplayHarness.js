import { vi } from 'vitest';
import { createHeadlessSandbox } from './_xtermHeadless.js';
import { TabManager } from '../web/terminal.js';
import { PTYWebSocket, terminalSubprotocol } from '../web/ws.js';
import { TerminalServerFrame } from '../web/proto/terminal.js';

const { Terminal } = createHeadlessSandbox();
export const encode = (text) => new TextEncoder().encode(text);

// A 64-bit field the caller omits stays absent on the wire, so the
// client under test sees a genuinely missing field. Bigint inputs
// pass through for hostile-range frontiers; fractional inputs throw
// here because no server can encode them.

export class ReplayWire {
    static OPEN = 1;
    constructor() {
        this.readyState = 1;
        this.protocol = terminalSubprotocol;
    }
    send() {}
    close() {
        this.closed = true;
    }
    emit(type, payload) {
        const frame = new Uint8Array(1 + payload.length);
        frame[0] = type;
        frame.set(payload, 1);
        this.onmessage?.({ data: frame.buffer });
    }
    head(info, checkpointBytes) {
        const big = (v) => (v === undefined ? undefined : BigInt(v));
        const epoch = big(info.epoch);
        const oldest = big(info.oldest);
        const head = big(info.head);
        const through = info.ckpt ? big(info.ckpt.through) : undefined;
        const ckpt = info.ckpt
            ? {
                  // Mirrors the old header shape: kind rides only when
                  // the caller sets it, so existing fixtures keep the
                  // string path instead of flipping to byte decoding.
                  ...(info.ckpt.kind !== undefined
                      ? { kind: info.ckpt.kind }
                      : {}),
                  ...(through !== undefined ? { through } : {}),
                  ...(info.ckpt.cols !== undefined
                      ? { cols: info.ckpt.cols }
                      : {}),
                  ...(info.ckpt.rows !== undefined
                      ? { rows: info.ckpt.rows }
                      : {}),
                  data:
                      checkpointBytes ??
                      (info.ckpt.ansi
                          ? encode(info.ckpt.ansi)
                          : new Uint8Array()),
                  ...(info.ckpt.eventCursor
                      ? { eventCursor: info.ckpt.eventCursor }
                      : {}),
              }
            : undefined;
        const replayFrom = big(info.replay_from);
        const frame = TerminalServerFrame.encode(
            TerminalServerFrame.fromPartial({
                payload: {
                    $case: 'attach',
                    value: {
                        ...(epoch !== undefined ? { epoch } : {}),
                        ...(oldest !== undefined ? { oldest } : {}),
                        ...(head !== undefined ? { head } : {}),
                        ...(ckpt ? { checkpoint: ckpt } : {}),
                        ...(replayFrom !== undefined ? { replayFrom } : {}),
                    },
                },
            }),
        ).finish();
        this.onmessage?.({ data: new Uint8Array(frame).buffer });
    }
    output(start, bytes) {
        const frame = TerminalServerFrame.encode(
            TerminalServerFrame.fromPartial({
                payload: {
                    $case: 'output',
                    value: { start: BigInt(start), data: bytes },
                },
            }),
        ).finish();
        this.onmessage?.({ data: new Uint8Array(frame).buffer });
    }
    exit(code) {
        const frame = TerminalServerFrame.encode(
            TerminalServerFrame.fromPartial({
                payload: { $case: 'exit', value: { code } },
            }),
        ).finish();
        this.onmessage?.({ data: new Uint8Array(frame).buffer });
    }
}

export function recordingEnvelope(bytes, start, end, extra = {}) {
    const json = encode(
        JSON.stringify({ epoch: 7, start, end, resizes: [], ...extra }),
    );
    const body = new Uint8Array(4 + json.length + bytes.length);
    new DataView(body.buffer).setUint32(0, json.length);
    body.set(json, 4);
    body.set(bytes, 4 + json.length);
    return { ok: true, status: 200, arrayBuffer: async () => body.buffer };
}

export function replayHarness(source, fault = null) {
    vi.stubGlobal('WebSocket', ReplayWire);
    const manager = Object.assign(Object.create(TabManager.prototype), {
        tabs: new Map(),
        updateDocumentTitle() {},
        syncBackendPin() {},
        _scheduleCheckpointUpload() {},
        _openTermAndViewport(tab) {
            tab._termOpened = true;
        },
    });
    const term = new Terminal({ cols: 240, rows: 12, scrollback: 10000 });
    const tape = [];
    const write = term.write.bind(term);
    term.write = (text, callback) => {
        tape.push(text);
        return write(text, callback);
    };
    const tab = {
        paneId: 'loss-audit',
        coder: 'pi',
        term,
        isDead: false,
        isBusy: true,
        writeBuffer: '',
        writePending: false,
        queuedSeq: 0,
        drainedSeq: 0,
        paneEpoch: 7,
        userFollowBottom: false,
    };
    const tasks = [];
    const requests = [];
    const fetcher = vi.fn(async (url) => {
        const query = new URL(url, 'http://localhost').searchParams;
        const from = Number(query.get('from'));
        const to = Number(query.get('through'));
        requests.push({ from, to, url: String(url) });
        const result = fault?.({ from, to, attempt: requests.length });
        if (result !== undefined && result !== null) return result;
        return recordingEnvelope(source.slice(from, to), from, to);
    });
    vi.stubGlobal('fetch', fetcher);
    const socket = () => {
        const pty = new PTYWebSocket(
            tab.paneId,
            (text) => manager._paneData(tab, text),
            null,
            null,
            null,
            {
                onAttachHead(info) {
                    const task = manager._onAttachHead(tab, info);
                    tasks.push(task);
                    return task;
                },
                onGap(from, to) {
                    const task = manager._onLiveGap(tab, from, to);
                    tasks.push(task);
                    return task;
                },
            },
        );
        tab.ws = pty;
        return pty;
    };
    const pty = socket();
    return {
        manager,
        term,
        tab,
        pty,
        socket,
        fetcher,
        requests,
        tape,
        async settle() {
            let done = 0;
            for (let round = 0; round < 100; round++) {
                const pending = tasks.slice(done);
                done = tasks.length;
                await Promise.all(pending);
                await Promise.all(tab._pendingBootstraps || []);
                await manager._drainSettled(tab);
                if (done === tasks.length && !tab._pendingBootstraps?.length)
                    return;
            }
            throw new Error('replay did not converge');
        },
        dispose() {
            tab.isDead = true;
            tab.ws.close();
            term.dispose();
        },
    };
}
