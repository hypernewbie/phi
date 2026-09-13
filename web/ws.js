/* Φ phi — Binary WebSocket Client */
// Parses a framed header [u32 jsonLen BE][json bytes][extra bytes].
// Returns null when the frame is too short or the JSON is malformed.
function parseFramedHeader(payload) {
    if (payload.byteLength < 4)
        return null;
    const view = new DataView(payload);
    const jsonLen = view.getUint32(0, false);
    if (4 + jsonLen > payload.byteLength)
        return null;
    try {
        const hdr = JSON.parse(new TextDecoder().decode(new Uint8Array(payload, 4, jsonLen)));
        return { hdr, extra: new Uint8Array(payload, 4 + jsonLen) };
    }
    catch (_e) {
        return null;
    }
}
export class PTYWebSocket {
    paneId;
    onData;
    onControl;
    onClose;
    onOpen;
    onAttachHead;
    onGap;
    url;
    ws;
    decoder;
    // hot-v1 state. mode is 'hot' after an 0x08 frame arrives, 'legacy'
    // after any legacy frame (old servers ignore term_proto), and
    // 'unknown' until the first frame decides.
    mode = 'unknown';
    // liveSeq is the next expected byte seq; lastFrameEnd is the end seq
    // of the newest delivered frame (hosts use it for checkpoint
    // bookkeeping). Both stay undefined until the head is known.
    liveSeq;
    lastFrameEnd;
    // Hot delivery is held from attach until release() so the host can
    // bootstrap the screen (checkpoint + bounded delta) without live
    // frames interleaving. Frames that arrive during a seq gap are held
    // until applyGapPatch() supplies the missing bytes.
    holding = true;
    held = [];
    constructor(paneId, onData, onControl, onClose, onOpen, opts) {
        this.paneId = paneId;
        this.onData = onData;
        this.onControl = onControl;
        this.onClose = onClose;
        this.onOpen = onOpen;
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
            if (this.onOpen)
                this.onOpen();
        };
        this.ws.onmessage = (event) => {
            const buffer = event.data;
            if (!(buffer instanceof ArrayBuffer))
                return;
            const view = new DataView(buffer);
            if (view.byteLength === 0)
                return;
            const msgType = view.getUint8(0);
            const payload = buffer.slice(1);
            switch (msgType) {
                case 0x01: // PTY Output Stdout (legacy framing)
                    this._markLegacy();
                    this.onData(this.decoder.decode(payload, { stream: true }));
                    break;
                case 0x02: // Control JSON Message
                    this._handleJsonPayload(payload, (data) => {
                        if (this.onControl)
                            this.onControl(data);
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
            if (this.onClose)
                this.onClose();
        };
        this.ws.onerror = (err) => {
            console.error(`[ws] Connection error for pane: ${paneId}`, err);
        };
    }
    // Legacy frames prove the server ignored term_proto (or the host
    // forced legacy mode): switch, release any hold, and let delivery
    // proceed exactly as the pre-hot protocol did.
    _markLegacy() {
        if (this.mode === 'legacy')
            return;
        this.mode = 'legacy';
        this.holding = false;
        this.held = [];
        this.liveSeq = undefined;
        this.lastFrameEnd = undefined;
    }
    _handleJsonPayload(payload, deliver) {
        try {
            const dec = new TextDecoder('utf-8');
            const jsonStr = dec.decode(payload);
            deliver(JSON.parse(jsonStr));
        }
        catch (e) {
            console.error('[ws] Failed to parse control JSON', e);
        }
    }
    _handleAttachHead(payload) {
        const parsed = parseFramedHeader(payload);
        if (!parsed) {
            console.error('[ws] Malformed ATTACH_HEAD frame');
            return;
        }
        this.mode = 'hot';
        const epoch = Number(parsed.hdr.epoch);
        const oldest = Number(parsed.hdr.oldest);
        const head = Number(parsed.hdr.head);
        this.liveSeq = head;
        this.lastFrameEnd = head;
        let ckpt = null;
        const c = parsed.hdr.ckpt;
        if (c && typeof c.through === 'number') {
            ckpt = {
                through: c.through,
                cols: Number(c.cols),
                rows: Number(c.rows),
                ansi: new TextDecoder().decode(parsed.extra),
            };
        }
        if (this.onAttachHead)
            this.onAttachHead({ epoch, oldest, head, ckpt });
    }
    _handleLiveOutput(payload) {
        if (this.mode !== 'hot' || this.liveSeq === undefined)
            return;
        if (payload.byteLength < 8)
            return;
        const view = new DataView(payload);
        const start = Number(view.getBigUint64(0, false));
        let bytes = new Uint8Array(payload, 8);
        // Duplicate suppression: a frame may re-deliver bytes the host
        // already patched over (overlap window). Skip what is old.
        if (start < this.liveSeq) {
            const overlap = this.liveSeq - start;
            if (overlap >= bytes.byteLength)
                return;
            bytes = bytes.subarray(overlap);
        }
        if (start > this.liveSeq) {
            // Gap: hold delivery until the host patches the missing range.
            this.held.push({ start, bytes });
            if (this.onGap)
                this.onGap(this.liveSeq, start);
            return;
        }
        if (this.holding) {
            this.held.push({ start, bytes });
            return;
        }
        this._deliver(start, bytes);
    }
    _deliver(start, bytes) {
        const text = this.decoder.decode(bytes, { stream: true });
        this.liveSeq = start + bytes.byteLength;
        this.lastFrameEnd = this.liveSeq;
        this.onData(text);
    }
    _flushHeld() {
        if (this.holding)
            return;
        const frames = this.held;
        this.held = [];
        for (let i = 0; i < frames.length; i++) {
            // Seq moved past a held frame's start (patch already covered
            // it); trim or drop it like a duplicate.
            let start = frames[i].start;
            let bytes = frames[i].bytes;
            if (start < this.liveSeq) {
                const overlap = this.liveSeq - start;
                if (overlap >= bytes.byteLength)
                    continue;
                bytes = bytes.subarray(overlap);
                start = this.liveSeq;
            }
            if (start > this.liveSeq) {
                // Internal gap: keep this frame and everything behind it
                // held, and ask the host to patch the missing range.
                // Delivering across it would skip bytes silently.
                this.held = frames.slice(i);
                if (this.onGap)
                    this.onGap(this.liveSeq, start);
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
    applyGapPatch(bytes) {
        if (this.mode !== 'hot' || this.liveSeq === undefined)
            return;
        this._deliver(this.liveSeq, bytes);
        this._flushHeld();
    }
    /** abandonGap() gives up on patching (range unavailable or too
     * large): skip to the gap end and flush what was held behind it. */
    abandonGap(to) {
        if (this.mode !== 'hot' || this.liveSeq === undefined)
            return;
        this.liveSeq = Math.max(this.liveSeq, to);
        this.lastFrameEnd = this.liveSeq;
        this._flushHeld();
    }
    sendInput(text) {
        if (this.ws.readyState !== WebSocket.OPEN)
            return false;
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
    sendResize(cols, rows) {
        if (this.ws.readyState !== WebSocket.OPEN)
            return;
        const buffer = new ArrayBuffer(5);
        const view = new DataView(buffer);
        view.setUint8(0, 0x02); // 0x02: Resize command
        view.setUint16(1, cols, false); // big-endian
        view.setUint16(3, rows, false); // big-endian
        this.ws.send(buffer);
    }
    close() {
        this.ws.close();
    }
}
