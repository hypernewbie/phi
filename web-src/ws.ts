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
    | 0x07; // md-changed (s→c)

// Callbacks the host registers on construction. All are optional;
// if omitted, the corresponding WS event becomes a no-op.
export interface PTYWebSocketCallbacks {
    onData?: (text: string) => void;
    onControl?: (msg: WSControlMessage) => void;
    onClose?: () => void;
    onOpen?: () => void;
}

export class PTYWebSocket {
    paneId: string;
    onData: (text: string) => void;
    onControl?: (msg: WSControlMessage) => void;
    onClose?: () => void;
    onOpen?: () => void;
    url: string;
    ws: WebSocket;
    decoder: TextDecoder;

    constructor(
        paneId: string,
        onData: (text: string) => void,
        onControl?: ((msg: WSControlMessage) => void) | null,
        onClose?: (() => void) | null,
        onOpen?: (() => void) | null,
    ) {
        this.paneId = paneId;
        this.onData = onData;
        this.onControl = onControl as typeof this.onControl;
        this.onClose = onClose as typeof this.onClose;
        this.onOpen = onOpen as typeof this.onOpen;

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        this.url = `${protocol}//${window.location.host}/ws/pane/${paneId}`;
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
                case 0x01: {
                    // PTY Output Stdout
                    const text = this.decoder.decode(payload, { stream: true });
                    this.onData(text);
                    break;
                }
                case 0x02: // Control JSON Message
                    try {
                        const dec = new TextDecoder('utf-8');
                        const jsonStr = dec.decode(payload);
                        const data = JSON.parse(jsonStr);
                        if (this.onControl) this.onControl(data);
                    } catch (e) {
                        console.error('[ws] Failed to parse control JSON', e);
                    }
                    break;
                case 0x03: // Pong
                    // Pong received successfully
                    break;
                case 0x04: // pty-exited
                    try {
                        const dec = new TextDecoder('utf-8');
                        const jsonStr = dec.decode(payload);
                        const data = JSON.parse(jsonStr);
                        if (this.onControl)
                            this.onControl({ type: 'pty-exited', ...data });
                    } catch (e) {
                        console.error(
                            '[ws] Failed to parse pty-exited JSON',
                            e,
                        );
                    }
                    break;
                case 0x05: // server-shutdown
                    try {
                        const dec = new TextDecoder('utf-8');
                        const jsonStr = dec.decode(payload);
                        const data = JSON.parse(jsonStr);
                        if (this.onControl)
                            this.onControl({
                                type: 'server-shutdown',
                                ...data,
                            });
                    } catch (e) {
                        console.error(
                            '[ws] Failed to parse server-shutdown JSON',
                            e,
                        );
                    }
                    break;
                case 0x06: // replay-complete
                    if (this.onControl)
                        this.onControl({ type: 'replay-complete' });
                    break;
                case 0x07: // md-changed
                    try {
                        const dec = new TextDecoder('utf-8');
                        const data = JSON.parse(dec.decode(payload));
                        if (this.onControl)
                            this.onControl({ type: 'md-changed', ...data });
                    } catch (e) {
                        console.error(
                            '[ws] Failed to parse md-changed JSON',
                            e,
                        );
                    }
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
