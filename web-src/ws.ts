/* Φ phi — Binary WebSocket Client */

// A loose shape for inbound control JSON. The wire schema is small
// but not formally typed on the server; consumers pattern-match
// against msg.type to discriminate ('pty-exited', 'server-shutdown',
// 'replay-complete'). Additional fields are spread onto the message
// verbatim by the receiving case-branch, so the catch-all `unknown`
// is intentional.
export interface WSControlMessage {
    type?:
        | 'pty-exited'
        | 'server-shutdown'
        | 'replay-complete'
        | 'md-changed'
        | string;
    [key: string]: unknown;
}

// One-character protocol byte used at offset 0 of every binary
// WS frame. Inbound and outbound namespaces overlap at 0x01
// (output vs. input) and 0x02 (control vs. resize), so the
// direction is implicit from the caller's perspective. Kept
// literal here for byte-identical compatibility with the
// server-side Go decoder in pkg/ws/.
export type WSMessageType =
    | 0x01 // output (s→c) / input (c→s)
    | 0x02 // control (s→c) / resize (c→s)
    | 0x03 // pong (s→c)
    | 0x04 // pty-exited (s→c)
    | 0x05 // server-shutdown (s→c)
    | 0x06 // replay-complete (s→c)
    | 0x07 // md-changed (s→c)
    | 0x08 // attach-head, hot-v1 (s→c)
    | 0x09; // live-output, hot-v1 (s→c)

// Callbacks the host registers on construction. All are optional;
// if omitted, the corresponding WS event becomes a no-op.
export interface PTYWebSocketCallbacks {
    onData?: (text: string) => void;
    onControl?: (msg: WSControlMessage) => void;
    onClose?: () => void;
    onOpen?: () => void;
}

// Hot-v1 terminal protocol (see temp/TERMPERF.md). The socket is
// requested with ?term_proto=hot-v1; a hot server answers with an
// 0x08 ATTACH_HEAD frame (epoch / oldest / head + optional opaque screen
// checkpoint) and then 0x09 LIVE_OUTPUT frames carrying absolute byte
// seqs. Deep history never enters the live stream — it is fetched over
// HTTP as bounded recording ranges instead.
export interface AttachCheckpoint {
    through: number;
    cols: number;
    rows: number;
    ansi: string;
}

export interface AttachHeadInfo {
    epoch: number;
    oldest: number;
    head: number;
    ckpt: AttachCheckpoint | null;
}

export interface PTYWebSocketOptions {
    hot?: boolean;
    onAttachHead?: (info: AttachHeadInfo) => void;
    onGap?: (from: number, to: number) => void;
}

// Parses a framed header [u32 jsonLen BE][json bytes][extra bytes].
// Returns null when the frame is too short or the JSON is malformed.
function parseFramedHeader(
    payload: ArrayBuffer,
): { hdr: Record<string, unknown>; extra: Uint8Array } | null {
    if (payload.byteLength < 4) return null;
    const view = new DataView(payload);
    const jsonLen = view.getUint32(0, false);
    if (4 + jsonLen > payload.byteLength) return null;
    try {
        const hdr = JSON.parse(
            new TextDecoder().decode(new Uint8Array(payload, 4, jsonLen)),
        );
        return { hdr, extra: new Uint8Array(payload, 4 + jsonLen) };
    } catch (_e) {
        return null;
    }
}

export class PTYWebSocket {
    paneId: string;
    onData: (text: string) => void;
    onControl?: (msg: WSControlMessage) => void;
    onClose?: () => void;
    onOpen?: () => void;
    onAttachHead?: (info: AttachHeadInfo) => void;
    onGap?: (from: number, to: number) => void;
    url: string;
    ws: WebSocket;
    decoder: TextDecoder;

    // hot-v1 state. mode is 'hot' after an 0x08 frame arrives, 'legacy'
    // after any legacy frame (old servers ignore term_proto), and
    // 'unknown' until the first frame decides.
    mode: 'unknown' | 'hot' | 'legacy' = 'unknown';
    // liveSeq is the next expected byte seq; lastFrameEnd is the end seq
    // of the newest delivered frame (hosts use it for checkpoint
    // bookkeeping). Both stay undefined until the head is known.
    liveSeq: number | undefined;
    lastFrameEnd: number | undefined;
    // Hot delivery is held from attach until release() so the host can
    // bootstrap the screen (checkpoint + bounded delta) without live
    // frames interleaving. Frames that arrive during a seq gap are held
    // until applyGapPatch() supplies the missing bytes.
    private holding = true;
    private held: Array<{ start: number; bytes: Uint8Array }> = [];

    constructor(
        paneId: string,
        onData: (text: string) => void,
        onControl?: ((msg: WSControlMessage) => void) | null,
        onClose?: (() => void) | null,
        onOpen?: (() => void) | null,
        opts?: PTYWebSocketOptions,
    ) {
        this.paneId = paneId;
        this.onData = onData;
        this.onControl = onControl as typeof this.onControl;
        this.onClose = onClose as typeof this.onClose;
        this.onOpen = onOpen as typeof this.onOpen;
        this.onAttachHead = opts?.onAttachHead;
        this.onGap = opts?.onGap;
        if (opts && opts.hot === false) {
            this.mode = 'legacy';
            this.holding = false;
        }

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        this.url = `${protocol}//${window.location.host}/ws/pane/${paneId}?term_proto=hot-v1`;
        this.ws = new WebSocket(this.url);
        this.ws.binaryType = 'arraybuffer';
        this.decoder = new TextDecoder('utf-8');

        this.ws.onopen = () => {
            console.log(`[ws] Connected for pane: ${paneId}`);
            if (this.onOpen) this.onOpen();
        };

        this.ws.onmessage = (event) => {
            const buffer = event.data;
            if (!(buffer instanceof ArrayBuffer)) return;

            const view = new DataView(buffer);
            if (view.byteLength === 0) return;

            const msgType = view.getUint8(0);
            const payload = buffer.slice(1);

            switch (msgType) {
                case 0x01: // PTY Output Stdout (legacy framing)
                    this._markLegacy();
                    this.onData(this.decoder.decode(payload, { stream: true }));
                    break;
                case 0x02: // Control JSON Message
                    this._handleJsonPayload(payload, (data) => {
                        if (this.onControl) this.onControl(data);
                    });
                    break;
                case 0x03: // Pong
                    // Pong received successfully
                    break;
                case 0x04: // pty-exited
                    this._handleJsonPayload(payload, (data) => {
                        if (this.onControl)
                            this.onControl({ type: 'pty-exited', ...data });
                    });
                    break;
                case 0x05: // server-shutdown
                    this._handleJsonPayload(payload, (data) => {
                        if (this.onControl)
                            this.onControl({
                                type: 'server-shutdown',
                                ...data,
                            });
                    });
                    break;
                case 0x06: // replay-complete (legacy framing)
                    this._markLegacy();
                    if (this.onControl)
                        this.onControl({ type: 'replay-complete' });
                    break;
                case 0x07: // md-changed
                    this._handleJsonPayload(payload, (data) => {
                        if (this.onControl)
                            this.onControl({ type: 'md-changed', ...data });
                    });
                    break;
                case 0x08: // ATTACH_HEAD (hot-v1)
                    this._handleAttachHead(payload);
                    break;
                case 0x09: // LIVE_OUTPUT (hot-v1)
                    this._handleLiveOutput(payload);
                    break;
            }
        };

        this.ws.onclose = () => {
            console.log(`[ws] Connection closed for pane: ${paneId}`);
            if (this.onClose) this.onClose();
        };

        this.ws.onerror = (err) => {
            console.error(`[ws] Connection error for pane: ${paneId}`, err);
        };
    }

    // Legacy frames prove the server ignored term_proto (or the host
    // forced legacy mode): switch, release any hold, and let delivery
    // proceed exactly as the pre-hot protocol did.
    private _markLegacy() {
        if (this.mode === 'legacy') return;
        this.mode = 'legacy';
        this.holding = false;
        this.held = [];
        this.liveSeq = undefined;
        this.lastFrameEnd = undefined;
    }

    private _handleJsonPayload(
        payload: ArrayBuffer,
        deliver: (data: Record<string, unknown>) => void,
    ) {
        try {
            const dec = new TextDecoder('utf-8');
            const jsonStr = dec.decode(payload);
            deliver(JSON.parse(jsonStr));
        } catch (e) {
            console.error('[ws] Failed to parse control JSON', e);
        }
    }

    private _handleAttachHead(payload: ArrayBuffer) {
        const parsed = parseFramedHeader(payload);
        if (!parsed) {
            console.error('[ws] Malformed ATTACH_HEAD frame');
            // No head means no seq base: staying held would brick the tab
            // silently. Close and let the host reconnect path redial.
            try {
                this.ws.close();
            } catch (_e) {}
            return;
        }
        this.mode = 'hot';
        const epoch = Number(parsed.hdr.epoch);
        const oldest = Number(parsed.hdr.oldest);
        const head = Number(parsed.hdr.head);
        this.liveSeq = head;
        this.lastFrameEnd = head;
        let ckpt: AttachCheckpoint | null = null;
        const c = parsed.hdr.ckpt as Record<string, unknown> | undefined;
        if (c && typeof c.through === 'number') {
            ckpt = {
                through: c.through,
                cols: Number(c.cols),
                rows: Number(c.rows),
                ansi: new TextDecoder().decode(parsed.extra),
            };
        }
        if (this.onAttachHead) this.onAttachHead({ epoch, oldest, head, ckpt });
    }

    private _handleLiveOutput(payload: ArrayBuffer) {
        if (this.mode !== 'hot' || this.liveSeq === undefined) return;
        if (payload.byteLength < 8) return;
        const view = new DataView(payload);
        const start = Number(view.getBigUint64(0, false));
        let bytes = new Uint8Array(payload, 8);
        // Duplicate suppression: a frame may re-deliver bytes the host
        // already patched over (overlap window). Skip what is old.
        if (start < this.liveSeq) {
            const overlap = this.liveSeq - start;
            if (overlap >= bytes.byteLength) return;
            bytes = bytes.subarray(overlap);
        }
        if (start > this.liveSeq) {
            // Gap: hold delivery until the host patches the missing range.
            this.held.push({ start, bytes });
            if (this.onGap) this.onGap(this.liveSeq, start);
            return;
        }
        if (this.holding) {
            this.held.push({ start, bytes });
            return;
        }
        this._deliver(start, bytes);
    }

    private _deliver(start: number, bytes: Uint8Array) {
        const text = this.decoder.decode(bytes, { stream: true });
        this.liveSeq = start + bytes.byteLength;
        this.lastFrameEnd = this.liveSeq;
        this.onData(text);
    }

    private _flushHeld() {
        if (this.holding) return;
        const frames = this.held;
        this.held = [];
        for (let i = 0; i < frames.length; i++) {
            // Seq moved past a held frame's start (patch already covered
            // it); trim or drop it like a duplicate.
            let start = frames[i].start;
            let bytes = frames[i].bytes;
            if (start < this.liveSeq!) {
                const overlap = this.liveSeq! - start;
                if (overlap >= bytes.byteLength) continue;
                bytes = bytes.subarray(overlap);
                start = this.liveSeq!;
            }
            if (start > this.liveSeq!) {
                // Internal gap: keep this frame and everything behind it
                // held, and ask the host to patch the missing range.
                // Delivering across it would skip bytes silently.
                this.held = frames.slice(i);
                if (this.onGap) this.onGap(this.liveSeq!, start);
                return;
            }
            this._deliver(start, bytes);
        }
    }

    /** release() starts live delivery. Call after the bootstrap writes
     * (checkpoint + delta) are queued so live frames land after them. */
    release() {
        this.holding = false;
        this._flushHeld();
    }

    /** applyGapPatch() supplies the missing recording bytes for a gap,
     * delivering them in order and flushing the frames held behind the
     * gap. `bytes` must be exactly the [from, to) range onGap reported. */
    applyGapPatch(bytes: Uint8Array) {
        if (this.mode !== 'hot' || this.liveSeq === undefined) return;
        this._deliver(this.liveSeq, bytes);
        this._flushHeld();
    }

    /** abandonGap() gives up on patching (range unavailable or too
     * large): skip to the gap end and flush what was held behind it. */
    abandonGap(to: number) {
        if (this.mode !== 'hot' || this.liveSeq === undefined) return;
        this.liveSeq = Math.max(this.liveSeq, to);
        this.lastFrameEnd = this.liveSeq;
        this._flushHeld();
    }

    sendInput(text: string): boolean {
        if (this.ws.readyState !== WebSocket.OPEN) return false;
        const encoder = new TextEncoder();
        const payload = encoder.encode(text);

        const buffer = new ArrayBuffer(1 + payload.length);
        const view = new DataView(buffer);
        view.setUint8(0, 0x01); // 0x01: Input data

        const uint8 = new Uint8Array(buffer);
        uint8.set(payload, 1);

        this.ws.send(buffer);
        return true;
    }

    sendResize(cols: number, rows: number): void {
        if (this.ws.readyState !== WebSocket.OPEN) return;
        const buffer = new ArrayBuffer(5);
        const view = new DataView(buffer);
        view.setUint8(0, 0x02); // 0x02: Resize command
        view.setUint16(1, cols, false); // big-endian
        view.setUint16(3, rows, false); // big-endian

        this.ws.send(buffer);
    }

    close(): void {
        this.ws.close();
    }
}
