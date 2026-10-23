// Synthetic Pi backend: loads the REAL committed bridge bundle and drives
// it with a minimal mock Pi host. Stdin lines map to lifecycle edges:
//   start       -> agent_start
//   settle      -> agent_end (stop) then agent_settled (completed)
//   abort       -> agent_settled (aborted)
//   say <text>  -> terminal output without any bridge event
//   exit        -> session_shutdown and process exit
// The script speaks the real generated protocol through the real Runtime;
// only the Pi host API surface is faked.
export function syntheticPiSource(bundlePath: string): string {
    return `#!/usr/bin/env node
const factory = require(${JSON.stringify(bundlePath)});
const handlers = new Map();
const mockPi = {
    on(event, handler) {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event).push(handler);
        return () => {};
    },
};
const mockCtx = () => ({
    sessionManager: {
        getSessionId: () => 'e2e-bridge-session',
        getLeafId: () => 'e2e-leaf-1',
    },
    model: { provider: 'e2e-provider', id: 'e2e-model' },
});
const emit = (event, payload) => {
    for (const handler of handlers.get(event) || []) handler(payload, mockCtx());
};
factory(mockPi);
emit('session_start', { type: 'session_start', reason: 'startup' });
console.log('synthetic pi ready');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.search(/[\\r\\n]/)) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        if (line === 'start') {
            emit('agent_start', { type: 'agent_start' });
            console.log('run started');
        } else if (line === 'settle') {
            emit('agent_end', { type: 'agent_end', messages: [{ role: 'assistant', content: [], stopReason: 'stop' }] });
            emit('agent_settled', { type: 'agent_settled', aborted: false });
            console.log('run settled');
        } else if (line === 'abort') {
            emit('agent_settled', { type: 'agent_settled', aborted: true });
            console.log('run aborted');
        } else if (line.startsWith('say ')) {
            console.log(line.slice(4));
        } else if (line === 'exit') {
            emit('session_shutdown', { type: 'session_shutdown' });
            process.exit(0);
        }
    }
});
process.stdin.on('end', () => process.exit(0));
`;
}
