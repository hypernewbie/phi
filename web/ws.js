/* Φ phi — Binary WebSocket Client */

export class PTYWebSocket {
    constructor(paneId, onData, onControl, onClose, onOpen) {
        this.paneId = paneId;
        this.onData = onData;
        this.onControl = onControl;
        this.onClose = onClose;
        this.onOpen = onOpen;
        
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
                case 0x01: // PTY Output Stdout
                    const text = this.decoder.decode(payload, { stream: true });
                    this.onData(text);
                    break;
                case 0x02: // Control JSON Message
                    try {
                        const dec = new TextDecoder('utf-8');
                        const jsonStr = dec.decode(payload);
                        const data = JSON.parse(jsonStr);
                        if (this.onControl) this.onControl(data);
                    } catch (e) {
                        console.error("[ws] Failed to parse control JSON", e);
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
                        if (this.onControl) this.onControl({ type: 'pty-exited', ...data });
                    } catch (e) {
                        console.error("[ws] Failed to parse pty-exited JSON", e);
                    }
                    break;
                case 0x05: // server-shutdown
                    try {
                        const dec = new TextDecoder('utf-8');
                        const jsonStr = dec.decode(payload);
                        const data = JSON.parse(jsonStr);
                        if (this.onControl) this.onControl({ type: 'server-shutdown', ...data });
                    } catch (e) {
                        console.error("[ws] Failed to parse server-shutdown JSON", e);
                    }
                    break;
                case 0x06: // replay-complete
                    if (this.onControl) this.onControl({ type: 'replay-complete' });
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
    
    sendInput(text) {
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
    
    sendResize(cols, rows) {
        if (this.ws.readyState !== WebSocket.OPEN) return;
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
