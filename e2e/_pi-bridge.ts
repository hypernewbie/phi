// Synthetic Pi backend: loads the REAL committed bridge bundle and drives
// it with a minimal mock Pi host. Stdin lines map to lifecycle edges:
//   start       -> agent_start
//   settle      -> agent_end (stop) then agent_settled (completed)
//   abort       -> agent_settled (aborted)
//   say <text>  -> terminal output without any bridge event
//   exit        -> session_shutdown and process exit
// With reload enabled, focus-selector/focus-editor switch the checked
// adapter target; release-reload settles the held native callback.
// The script speaks the real generated protocol through the real Runtime;
// only the Pi host API surface is faked.
export function syntheticPiSource(
    bundlePath: string,
    { reload = false }: { reload?: boolean } = {},
): string {
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
let running = false;
let releaseReload;
class CustomEditor {
    history = [];
    async onSubmit(text) {
        console.log('native command entered: ' + text);
        await new Promise((resolve) => { releaseReload = resolve; });
    }
}
const editor = new CustomEditor();
let focused = editor;
const mockCtx = () => ({
    ...(${reload} ? {
        isIdle: () => !running,
        hasPendingMessages: () => false,
        ui: {
            getEditorComponent: () => undefined,
            setWidget: (_key, factory) => factory?.({ getFocusedComponent: () => focused }),
        },
    } : {}),
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
            running = true;
            emit('agent_start', { type: 'agent_start' });
            console.log('run started');
        } else if (line === 'settle') {
            running = false;
            emit('agent_end', { type: 'agent_end', messages: [{ role: 'assistant', content: [], stopReason: 'stop' }] });
            emit('agent_settled', { type: 'agent_settled', aborted: false });
            console.log('run settled');
        } else if (line === 'abort') {
            running = false;
            emit('agent_settled', { type: 'agent_settled', aborted: true });
            console.log('run aborted');
        } else if (line === 'release-reload') {
            releaseReload?.();
        } else if (line === 'focus-selector' || line === 'focus-editor') {
            focused = line === 'focus-editor' ? editor : {};
            console.log('focus is now ' + line);
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
