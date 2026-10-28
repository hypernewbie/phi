/* Φ phi — Binary WebSocket Client */
import { TerminalClientFrame, TerminalServerFrame } from './proto/terminal.js';
import { terminalSubprotocol } from './ws-protocols.js';
import { wsUrl } from './util.js';
export { terminalSubprotocol };
// Inbound whole-message bound, matching the server and native limits.
// The browser allocates the ArrayBuffer before this check runs, so it
// caps decoding work, not the allocation itself.
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
// Single checkpoint/output span bound, matching the server's 2 MiB cap.
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
// Bound for the queue that holds live frames behind a bootstrap or a gap.
const MAX_HELD_BYTES = 2 * 1024 * 1024;
const MAX_HELD_SPANS = 256;
// Outbound raw input span; larger pastes go out as ordered frames.
const MAX_INPUT_CHUNK = 1 * 1024 * 1024;
// Narrow one 64-bit field to a safe integer. Absent and out-of-range
// values are both unusable as sequence numbers.
function toSafeInt(v) {
    if (v === undefined)
        return undefined;
    if (v < 0 || v > BigInt(Number.MAX_SAFE_INTEGER))
        return undefined;
    return Number(v);
}
// Narrow one 64-bit field to an exact decimal string. Only presence
// matters; every uint64 has an exact decimal rendering.
function toUintString(v) {
    if (v === undefined)
        return undefined;
    return v.toString();
}
// Render one sync message as the JSON shape the old sync payload
// carried, so downstream consumers see no difference. Millisecond
// timestamps render as ISO-8601 UTC strings.
function toSyncMessageJson(m) {
    const out = {};
    if (m.key !== undefined)
        out.key = m.key;
    if (m.value !== undefined)
        out.value = m.value;
    const created = toSafeInt(m.createdAtUnixMs);
    if (created !== undefined)
        out.created_at = new Date(created).toISOString();
    const updated = toSafeInt(m.updatedAtUnixMs);
    if (updated !== undefined)
        out.updated_at = new Date(updated).toISOString();
    return out;
}
// Decoder instances survive a same-pane reconnect. Keep their incomplete
// UTF-8 prefix with them so checkpoints can rewind to a complete boundary.
const decoderPrefixes = new WeakMap();
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
    /** Fire-and-forget host callback: a throwing or rejecting host must
     * never break the socket pump. (Hosts are async, so the promise is
     * observed here and nowhere else.) */
    _notify(fn, ...args) {
        if (typeof fn !== 'function')
            return;
        try {
            Promise.resolve(fn(...args)).catch(() => { });
        }
        catch (_e) { }
    }
    // mode is 'hot' after an attach frame arrives, 'unknown' until then.
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
    heldBytes = 0;
    /** Retained view: validate and sequence live frames, but store nothing. */
    discarding = false;
    constructor(paneId, onData, onControl, onClose, onOpen, opts) {
        this.paneId = paneId;
        this.onData = onData;
        this.onControl = onControl;
        this.onClose = onClose;
        this.onOpen = onOpen;
        this.onAttachHead = opts?.onAttachHead;
        this.onGap = opts?.onGap;
        this.url = wsUrl(`/ws/pane/${paneId}?state=ansi-v1`);
        this.ws = new WebSocket(this.url, terminalSubprotocol);
        this.ws.binaryType = 'arraybuffer';
        this.decoder = new TextDecoder('utf-8');
        this.ws.onopen = () => {
            const negotiated = this.ws.protocol;
            // Test fakes omit the attribute; real servers must select it.
            if (negotiated !== undefined &&
                negotiated !== terminalSubprotocol) {
                console.error(`[ws] Server did not select ${terminalSubprotocol}`);
                try {
                    this.ws.close();
                }
                catch (_e) { }
                return;
            }
            console.log(`[ws] Connected for pane: ${paneId}`);
            if (this.onOpen)
                this.onOpen();
        };
        this.ws.onmessage = (event) => {
            const buffer = event.data;
            // The pane endpoint is binary-only. A text or empty frame must
            // fail closed, like every other malformed frame.
            if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) {
                console.error(`[ws] Malformed pane frame for: ${paneId}`);
                try {
                    this.ws.close();
                }
                catch (_e) { }
                return;
            }
            if (buffer.byteLength > MAX_MESSAGE_BYTES) {
                try {
                    this.ws.close();
                }
                catch (_e) { }
                return;
            }
            let frame;
            try {
                frame = TerminalServerFrame.decode(new Uint8Array(buffer));
            }
            catch (e) {
                console.error('[ws] Malformed terminal frame', e);
                try {
                    this.ws.close();
                }
                catch (_e) { }
                return;
            }
            const payload = frame.payload;
            if (payload === undefined) {
                try {
                    this.ws.close();
                }
                catch (_e) { }
                return;
            }
            switch (payload.$case) {
                case 'attach':
                    this._handleAttachHead(payload.value);
                    break;
                case 'output':
                    this._handleLiveOutput(payload.value);
                    break;
                case 'pong':
                    // Pong received successfully
                    break;
                case 'exit':
                    if (this.onControl)
                        this.onControl({
                            type: 'pty-exited',
                            code: payload.value.code ?? 0,
                        });
                    break;
                case 'dropNotice':
                    if (this.onControl)
                        this.onControl({ type: 'output-dropped' });
                    break;
                case 'title':
                    this._handleTitle(payload.value);
                    break;
                case 'bridgeState':
                    this._handleBridgeState(payload.value);
                    break;
                case 'settlement':
                    this._handleSettlement(payload.value);
                    break;
                case 'notification':
                    this._handleNotification(payload.value);
                    break;
                default:
                    // Unknown server payload: no safe interpretation, so
                    // close and let the host reconnect path redial.
                    try {
                        this.ws.close();
                    }
                    catch (_e) { }
                    return;
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
    _handleTitle(title) {
        const revision = toSafeInt(title.revision);
        if (revision === undefined) {
            // The host orders titles by revision; an unusable one is
            // dropped rather than delivered unsorted. The server caps
            // revisions below 2^53, so this never fires in practice.
            console.error('[ws] Title revision out of safe range; ignoring');
            return;
        }
        if (this.onControl)
            this.onControl({
                type: 'session-title',
                pane_id: title.paneId ?? '',
                session_id: title.sessionId ?? '',
                title: title.title ?? '',
                revision,
            });
    }
    _handleBridgeState(state) {
        if (!this.onControl)
            return;
        // Absent keys stay absent: the host distinguishes a missing
        // running/connected from an explicit false.
        const msg = { type: 'pi-bridge-state' };
        if (state.paneId !== undefined)
            msg.pane_id = state.paneId;
        if (state.state !== undefined)
            msg.state = state.state;
        if (state.reason !== undefined)
            msg.reason = state.reason;
        const generation = toUintString(state.generation);
        if (generation !== undefined)
            msg.generation = generation;
        const telemetryRevision = toUintString(state.telemetryRevision);
        if (telemetryRevision !== undefined)
            msg.telemetry_revision = telemetryRevision;
        const lastRun = toUintString(state.lastRun);
        if (lastRun !== undefined)
            msg.last_run = lastRun;
        if (state.lastOutcome !== undefined)
            msg.last_outcome = state.lastOutcome;
        if (state.running !== undefined)
            msg.running = state.running;
        if (state.connected !== undefined)
            msg.connected = state.connected;
        if (state.model !== undefined)
            msg.model = state.model;
        if (state.thinkingLevel !== undefined)
            msg.thinking_level = state.thinkingLevel;
        if (state.contextTokens !== undefined)
            msg.context_tokens = state.contextTokens;
        if (state.contextWindow !== undefined)
            msg.context_window = state.contextWindow;
        if (state.contextPercent !== undefined)
            msg.context_percent = state.contextPercent;
        if (state.compactIdle !== undefined)
            msg.compact_idle = state.compactIdle;
        if (state.compactQueued !== undefined)
            msg.compact_queued = state.compactQueued;
        if (state.compactActive !== undefined)
            msg.compact_active = state.compactActive;
        if (state.compactPending !== undefined)
            msg.compact_pending = state.compactPending;
        if (state.capabilities.length > 0)
            msg.capabilities = [...state.capabilities];
        this.onControl(msg);
    }
    _handleSettlement(settlement) {
        if (!this.onControl)
            return;
        const msg = { type: 'pi-bridge-settled' };
        if (settlement.paneId !== undefined)
            msg.pane_id = settlement.paneId;
        const generation = toUintString(settlement.generation);
        if (generation !== undefined)
            msg.generation = generation;
        const run = toUintString(settlement.run);
        if (run !== undefined)
            msg.run = run;
        if (settlement.outcome !== undefined)
            msg.outcome = settlement.outcome;
        this.onControl(msg);
    }
    _handleNotification(notif) {
        const kind = notif.kind;
        // An empty notification carries no hint; ignoring it is safe.
        if (kind === undefined)
            return;
        switch (kind.$case) {
            case 'markdownChanged':
                if (this.onControl)
                    this.onControl({
                        type: 'md-changed',
                        dir: kind.value.dir ?? '',
                    });
                break;
            case 'syncChanged':
                this._handleSyncChanged(kind.value);
                break;
            case 'shutdown':
                if (this.onControl)
                    this.onControl({
                        type: 'server-shutdown',
                        reason: kind.value.reason ?? '',
                    });
                break;
        }
    }
    _handleSyncChanged(sync) {
        if (!this.onControl)
            return;
        const msg = { type: 'sync-changed' };
        if (sync.action !== undefined)
            msg.action = sync.action;
        if (sync.key !== undefined)
            msg.key = sync.key;
        if (sync.msg !== undefined)
            msg.msg = toSyncMessageJson(sync.msg);
        this.onControl(msg);
    }
    _handleAttachHead(attach) {
        const epoch = toSafeInt(attach.epoch);
        const oldest = toSafeInt(attach.oldest);
        const head = toSafeInt(attach.head);
        if (epoch === undefined ||
            oldest === undefined ||
            head === undefined ||
            oldest > head) {
            console.error('[ws] Malformed ATTACH_HEAD frame');
            // No head means no seq base: staying held would brick the tab
            // silently. Close and let the host reconnect path redial.
            try {
                this.ws.close();
            }
            catch (_e) { }
            return;
        }
        this.mode = 'hot';
        this.liveSeq = head;
        this.lastFrameEnd = head;
        let ckpt = null;
        const c = attach.checkpoint;
        const validCursor = (v) => typeof v === 'string' &&
            v.length <= 128 &&
            /^v1\.\d+\.\d+\.\d+$/.test(v);
        if (c) {
            const through = toSafeInt(c.through);
            const data = c.data ?? new Uint8Array();
            if (through !== undefined &&
                through >= oldest &&
                through <= head &&
                data.byteLength <= MAX_PAYLOAD_BYTES &&
                Number.isInteger(c.cols) &&
                Number(c.cols) > 0 &&
                Number(c.cols) <= 65535 &&
                Number.isInteger(c.rows) &&
                Number(c.rows) > 0 &&
                Number(c.rows) <= 65535 &&
                (c.kind === undefined || c.kind === 'ansi-v1') &&
                (c.eventCursor === undefined || validCursor(c.eventCursor))) {
                ckpt = {
                    through,
                    kind: 'ansi-v1',
                    cols: Number(c.cols),
                    rows: Number(c.rows),
                    ansi: new TextDecoder().decode(data),
                    ...(c.kind === 'ansi-v1' ? { bytes: data } : {}),
                    ...(c.eventCursor === undefined
                        ? {}
                        : { eventCursor: c.eventCursor }),
                };
            }
        }
        if (c !== undefined && c !== null && !ckpt) {
            // A malformed snapshot is not permission to fetch the library
            // from zero. Retry an authoritative attach instead.
            try {
                this.ws.close();
            }
            catch (_e) { }
            return;
        }
        const replayFrom = toSafeInt(attach.replayFrom);
        this._notify(this.onAttachHead, {
            epoch,
            oldest,
            head,
            ckpt,
            ...(replayFrom !== undefined &&
                replayFrom >= oldest &&
                replayFrom <= head
                ? { replayFrom }
                : {}),
        });
    }
    _handleLiveOutput(out) {
        if (this.mode !== 'hot' || this.liveSeq === undefined) {
            // Without the atomic attach frontier, no live byte is safe to
            // deliver. Reconnect and recover it from the recording instead.
            try {
                this.ws.close();
            }
            catch (_e) { }
            return;
        }
        let start = toSafeInt(out.start);
        let bytes = out.data ?? new Uint8Array();
        if (start === undefined ||
            !Number.isSafeInteger(start + bytes.byteLength) ||
            bytes.byteLength > MAX_PAYLOAD_BYTES) {
            try {
                this.ws.close();
            }
            catch (_e) { }
            return;
        }
        // Duplicate suppression: a frame may re-deliver bytes the host
        // already patched over (overlap window). Skip what is old.
        if (start < this.liveSeq) {
            const overlap = this.liveSeq - start;
            if (overlap >= bytes.byteLength)
                return;
            bytes = bytes.subarray(overlap);
            // The tail now begins at the current frontier. Retaining the
            // original offset would regress liveSeq (or trim it twice
            // when a bootstrap-held frame is released).
            start = this.liveSeq;
        }
        if (this.discarding) {
            // A retained view owns the screen. W may cross holes here; P never
            // does, because nothing is parsed, queued, or gap-fetched.
            this.liveSeq = start + bytes.byteLength;
            this.lastFrameEnd = this.liveSeq;
            return;
        }
        if (start > this.liveSeq) {
            // Gap: hold delivery until the host patches the missing range.
            if (!this._holdFrame(start, bytes))
                return;
            this._notify(this.onGap, this.liveSeq, start);
            return;
        }
        if (this.holding) {
            this._holdFrame(start, bytes);
            return;
        }
        this._deliver(start, bytes);
    }
    get pendingUTF8Bytes() {
        return decoderPrefixes.get(this.decoder)?.byteLength ?? 0;
    }
    decodeOutput(bytes) {
        const prior = decoderPrefixes.get(this.decoder) ?? new Uint8Array();
        const tail = new Uint8Array(prior.length + Math.min(4, bytes.length));
        tail.set(prior);
        tail.set(bytes.subarray(Math.max(0, bytes.length - 4)), prior.length);
        let start = tail.length - 1;
        while (start >= 0 && tail[start] >= 0x80 && tail[start] <= 0xbf)
            start--;
        const lead = tail[start];
        const need = lead >= 0xc2 && lead <= 0xdf
            ? 2
            : lead >= 0xe0 && lead <= 0xef
                ? 3
                : lead >= 0xf0 && lead <= 0xf4
                    ? 4
                    : 0;
        const second = tail[start + 1];
        const valid = second === undefined ||
            !((lead === 0xe0 && second < 0xa0) ||
                (lead === 0xed && second > 0x9f) ||
                (lead === 0xf0 && second < 0x90) ||
                (lead === 0xf4 && second > 0x8f));
        const prefix = valid && need && tail.length - start < need
            ? tail.slice(start)
            : new Uint8Array();
        decoderPrefixes.set(this.decoder, prefix);
        return this.decoder.decode(bytes, { stream: true });
    }
    _deliver(start, bytes) {
        const text = this.decodeOutput(bytes);
        this.liveSeq = start + bytes.byteLength;
        this.lastFrameEnd = this.liveSeq;
        this.onData(text);
    }
    _flushHeld() {
        if (this.holding)
            return;
        const frames = this.held;
        this.held = [];
        this.heldBytes = 0;
        for (let i = 0; i < frames.length; i++) {
            // Seq moved past a held frame's start (patch already covered
            // it); trim or drop it like a duplicate.
            let start = frames[i].start;
            let bytes = frames[i].bytes;
            const liveSeq = this.liveSeq ?? 0;
            if (start < liveSeq) {
                const overlap = liveSeq - start;
                if (overlap >= bytes.byteLength)
                    continue;
                bytes = bytes.subarray(overlap);
                start = liveSeq;
            }
            if (start > liveSeq) {
                // Internal gap: keep this frame and everything behind it
                // held, and ask the host to patch the missing range.
                // Delivering across it would skip bytes silently.
                this.held = frames.slice(i);
                this._notify(this.onGap, liveSeq, start);
                return;
            }
            this._deliver(start, bytes);
        }
    }
    /** release() starts live delivery. Call after the bootstrap writes
     * (checkpoint + delta) are queued so live frames land after them. */
    hold() {
        this.holding = true;
    }
    /** discard() freezes live delivery for a retained view: later frames are
     * sequenced and dropped, so nothing accumulates and no gap is reported.
     * Only an explicit resync rebuilds the stream. */
    discard() {
        this.discarding = true;
        this.held = [];
        this.heldBytes = 0;
    }
    /** A hold is bounded: an unbounded queue behind a stalled bootstrap is a
     * memory leak, and no caller can replay more than the cap in one pass.
     * Overflow reconnects instead of silently dropping bytes into a parser. */
    _holdFrame(start, bytes) {
        const next = this.heldBytes + bytes.byteLength;
        if (this.held.length >= MAX_HELD_SPANS ||
            next > MAX_HELD_BYTES) {
            this.held = [];
            this.heldBytes = 0;
            this.holding = false;
            try {
                this.ws.close();
            }
            catch (_e) { }
            return false;
        }
        this.held.push({ start, bytes });
        this.heldBytes = next;
        return true;
    }
    release() {
        this.holding = false;
        this._flushHeld();
    }
    /** Adopt an authoritative current-state snapshot, never an arbitrary skip.
     * Older output stays available in the recording; frames covered by the
     * snapshot are duplicates. Used only after its parser write has settled. */
    adoptState(through) {
        if (this.mode !== 'hot' ||
            !Number.isSafeInteger(through) ||
            through < 0)
            return;
        this.liveSeq = Math.max(this.liveSeq ?? 0, through);
        this.lastFrameEnd = this.liveSeq;
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
        if (to > this.liveSeq) {
            // Bytes on the other side of a real hole must not complete a
            // UTF-8 prefix retained from before the missing interval.
            this.decoder = new TextDecoder('utf-8');
        }
        this.liveSeq = Math.max(this.liveSeq, to);
        this.lastFrameEnd = this.liveSeq;
        this._flushHeld();
    }
    sendInput(text) {
        if (this.ws.readyState !== WebSocket.OPEN)
            return false;
        return this._sendChunks(new TextEncoder().encode(text));
    }
    // xterm's onBinary carries byte-valued strings (not Unicode text),
    // notably classic mouse reports with coordinates above ASCII.
    sendBinaryInput(data) {
        if (this.ws.readyState !== WebSocket.OPEN)
            return false;
        const payload = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++)
            payload[i] = data.charCodeAt(i);
        return this._sendChunks(payload);
    }
    // Large pastes go out as ordered raw spans so every message stays
    // far inside the whole-message bound. Splitting is byte-exact, so
    // multi-byte sequences straddling a boundary reassemble verbatim.
    _sendChunks(payload) {
        try {
            for (let at = 0; at < payload.length; at += MAX_INPUT_CHUNK) {
                const frame = TerminalClientFrame.encode(TerminalClientFrame.fromPartial({
                    payload: {
                        $case: 'input',
                        value: payload.subarray(at, at + MAX_INPUT_CHUNK),
                    },
                })).finish();
                this.ws.send(frame);
            }
        }
        catch (_e) {
            return false;
        }
        return true;
    }
    // Reports whether the resize actually went out: callers that must
    // not lose an unsent sizing (first-fit backend sync) gate retries
    // on this. A not-open socket or out-of-range geometry is a quiet
    // false, never a throw.
    sendResize(cols, rows) {
        if (this.ws.readyState !== WebSocket.OPEN)
            return false;
        if (!Number.isInteger(cols) ||
            !Number.isInteger(rows) ||
            cols < 1 ||
            rows < 1 ||
            cols > 65535 ||
            rows > 65535)
            return false;
        try {
            const frame = TerminalClientFrame.encode(TerminalClientFrame.fromPartial({
                payload: { $case: 'resize', value: { cols, rows } },
            })).finish();
            this.ws.send(frame);
        }
        catch (_e) {
            return false;
        }
        return true;
    }
    close() {
        this.onClose = undefined;
        this.onOpen = undefined;
        this.onData = () => { };
        this.onControl = undefined;
        this.onAttachHead = undefined;
        this.onGap = undefined;
        if (this.ws) {
            this.ws.onclose = null;
            this.ws.onerror = null;
            this.ws.onmessage = null;
            this.ws.onopen = null;
            try {
                this.ws.close();
            }
            catch (_e) { }
        }
    }
}
