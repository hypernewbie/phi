'use strict';

// Deterministic `pi --mode rpc` fixture for the chat control endpoint.
//
// Phi spawns this file as its real Pi child through a fixture-owned PATH:
// pkg/rpc/spawn.go runs `pi --mode rpc [--session PATH]`, and the fixture
// launcher puts this script behind that name. It answers the JSONL commands
// the control plane issues, streams one canned assistant turn with a tool
// result, and rejects two operations on purpose so the browser spec can
// assert a correlated error and a successful retry. It never calls a
// provider, and it exits on an unknown command instead of delegating.

const fs = require('node:fs');
const readline = require('node:readline');

const logPath = process.env.PI_FIXTURE_LOG || '';
const log = (entry) => {
    if (!logPath) return;
    try {
        fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
    } catch {}
};

log({ kind: 'start', argv: process.argv.slice(2), pid: process.pid });
process.stdout.on('error', () => {});

const state = { model: 'fixture-model', thinking: 'low', busy: false, queue: 0 };
let lastPrompt = '';

const send = (frame) => {
    process.stdout.write(JSON.stringify(frame) + '\n');
};
const respond = (id, command, data, error) => {
    const frame = { type: 'response', id, command, success: true, data };
    if (error) {
        frame.success = false;
        frame.error = error;
        delete frame.data;
    }
    send(frame);
};
const currentState = () => ({
    model: { name: state.model, provider: 'fixture' },
    thinkingLevel: state.thinking,
    isStreaming: state.busy,
    isCompacting: false,
    pendingMessageCount: state.queue,
});

const streamTurn = () => {
    state.busy = true;
    send({ type: 'agent_start' });
    // Pi echoes the user prompt as its own message before the assistant turn.
    if (lastPrompt)
        send({
            type: 'message_end',
            message: {
                role: 'user',
                content: [{ type: 'text', text: lastPrompt }],
            },
        });
    send({
        type: 'message_start',
        message: { role: 'assistant', content: [] },
    });
    send({
        type: 'message_update',
        assistantMessageEvent: {
            type: 'text_delta',
            contentIndex: 0,
            delta: 'Fixture ',
        },
    });
    send({
        type: 'message_update',
        assistantMessageEvent: {
            type: 'text_delta',
            contentIndex: 0,
            delta: 'reply.',
        },
    });
    send({
        type: 'message_end',
        message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Fixture reply.' }],
            stopReason: 'stop',
        },
    });
    send({
        type: 'message_end',
        message: {
            role: 'toolResult',
            content: [{ type: 'text', text: 'fixture tool output' }],
            details: { exit: 0 },
            toolCallId: 'call-1',
            toolName: 'bash',
            isError: false,
        },
    });
    state.busy = false;
    send({ type: 'agent_end' });
    send({ type: 'agent_settled' });
};

const handlers = {
    get_state: (id) => respond(id, 'get_state', currentState()),
    get_session_stats: (id) =>
        respond(id, 'get_session_stats', {
            tokens: { input: 11, output: 22, cacheRead: 0, cacheWrite: 0 },
            contextUsage: { tokens: 3, contextWindow: 200000 },
        }),
    get_commands: (id) => respond(id, 'get_commands', { commands: [] }),
    get_available_models: (id) =>
        respond(id, 'get_available_models', {
            models: [
                {
                    provider: 'fixture',
                    id: 'fixture-model',
                    name: 'Fixture model',
                },
                {
                    provider: 'fixture',
                    id: 'fixture-rejected',
                    name: 'Rejected model',
                },
            ],
        }),
    get_available_thinking_levels: (id) =>
        respond(id, 'get_available_thinking_levels', {
            levels: ['low', 'high'],
        }),
    set_model: (id, command) => {
        if (command.modelId === 'fixture-rejected') {
            respond(id, 'set_model', null, 'model is rejected by the fixture');
            return;
        }
        state.model = command.modelId;
        respond(id, 'set_model', {});
    },
    set_thinking_level: (id, command) => {
        // 'low' is rejected so the browser spec can assert a correlated
        // error; 'high' succeeds and is visible in the status bar.
        if (command.level === 'low') {
            respond(
                id,
                'set_thinking_level',
                null,
                'thinking level is rejected by the fixture',
            );
            return;
        }
        state.thinking = command.level;
        respond(id, 'set_thinking_level', {});
    },
    set_session_name: (id) => respond(id, 'set_session_name', {}),
    new_session: (id) => respond(id, 'new_session', { cancelled: false }),
    abort: (id) => respond(id, 'abort', {}),
    compact: (id) => respond(id, 'compact', {}),
    prompt: (id, command) => {
        lastPrompt = typeof command.message === 'string' ? command.message : '';
        respond(id, 'prompt', {});
        setImmediate(streamTurn);
    },
};

// Record the resumed session path so the spec can prove the spawn carried it.
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--session')
        log({ kind: 'session', path: argv[index + 1] });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let command;
    try {
        command = JSON.parse(text);
    } catch {
        log({ kind: 'malformed', text });
        process.exit(2);
    }
    log({ kind: 'command', type: command.type, id: command.id });
    const handler = handlers[command.type];
    if (!handler) {
        log({ kind: 'unknown', type: command.type });
        process.exit(1);
    }
    handler(command.id, command);
});
rl.on('close', () => process.exit(0));
