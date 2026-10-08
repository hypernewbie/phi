import { vi } from 'vitest';
import { createHeadlessSandbox } from './_xtermHeadless.js';
import { TabManager } from '../web/terminal.js';
import { PTYWebSocket } from '../web/ws.js';

const { Terminal } = createHeadlessSandbox();
export const encode = (text) => new TextEncoder().encode(text);

export class ReplayWire {
    static OPEN = 1;
    constructor() {
        this.readyState = 1;
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
        const json = encode(JSON.stringify(info));
        const extra =
            checkpointBytes ??
            (info.ckpt?.ansi ? encode(info.ckpt.ansi) : new Uint8Array());
        const payload = new Uint8Array(4 + json.length + extra.length);
        new DataView(payload.buffer).setUint32(0, json.length);
        payload.set(json, 4);
        payload.set(extra, 4 + json.length);
        this.emit(0x08, payload);
    }
    output(start, bytes) {
        const payload = new Uint8Array(8 + bytes.length);
        new DataView(payload.buffer).setBigUint64(0, BigInt(start));
        payload.set(bytes, 8);
        this.emit(0x09, payload);
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
