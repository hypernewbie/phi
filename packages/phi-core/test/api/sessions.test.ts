import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
    decodeSessionPage,
    listSessions,
    renameSession,
    sessionsUrl,
} from '../../src/api/sessions.ts';
import type {
    ApiRequest,
    ApiTransport,
    TransportResult,
} from '../../src/api/types.ts';

const fixtureDir = fileURLToPath(new URL('../fixtures/', import.meta.url));
const sessionsText = readFileSync(fixtureDir + 'sessions.json', 'utf8');

const signal = { aborted: false };
const options = {
    coder: 'pi',
    cwd: '/tmp/stage05-probe/ws',
    limit: 10,
    signal,
    bearer: 'live-token',
};

function fakeTransport(result: TransportResult | Error): {
    transport: ApiTransport;
    requests: ApiRequest[];
} {
    const requests: ApiRequest[] = [];
    const transport: ApiTransport = async (request) => {
        requests.push(request);
        if (result instanceof Error) throw result;
        return result;
    };
    return { transport, requests };
}

const ok = (text: string): TransportResult => ({
    kind: 'response',
    status: 200,
    text,
});

it('builds the exact session list URL', () => {
    expect(sessionsUrl('a&b', '', 10)).toBe(
        '/api/sessions?coder=a%26b&cwd=&limit=10&offset=0',
    );
    expect(sessionsUrl('pi', '/tmp/ws', 2, 4)).toBe(
        '/api/sessions?coder=pi&cwd=%2Ftmp%2Fws&limit=2&offset=4',
    );
});

it('decodes a page in order with identity fields intact', async () => {
    const { transport } = fakeTransport(ok(sessionsText));
    const outcome = await listSessions(transport, options);
    expect(outcome).toMatchObject({
        kind: 'ok',
        sessions: [
            {
                id: 'probe-session-3',
                coder: 'pi',
                cwd: '/tmp/stage05-probe/ws',
                session_path: '/tmp/stage05-probe/ws/.pi/session-3',
            },
            { id: 'probe-session-2', coder: 'pi' },
            { id: 'probe-session-1', coder: 'opencode' },
        ],
    });
});

it('drops unknown wire fields', async () => {
    const { transport } = fakeTransport(ok(sessionsText));
    const outcome = await listSessions(transport, options);
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    for (const session of outcome.sessions)
        expect('env' in session).toBe(false);
});

it.each([
    ['empty id', { id: '', title: 't', time_updated: '2026-11-03T22:00:00Z' }],
    ['numeric id', { id: 7, title: 't', time_updated: '2026-11-03T22:00:00Z' }],
    ['missing id', { title: 't', time_updated: '2026-11-03T22:00:00Z' }],
])('rejects the whole page on %s', async (_name, bad) => {
    const { transport } = fakeTransport(ok(JSON.stringify([bad])));
    const outcome = await listSessions(transport, options);
    expect(outcome).toEqual({ kind: 'invalid-response' });
});

it.each([
    ['garbage date', 'not-a-date'],
    ['numeric date', 12345],
])('rejects the page on %s', async (_name, time_updated) => {
    const body = JSON.stringify([
        { id: 'a', title: 't', time_updated },
    ]);
    const { transport } = fakeTransport(ok(body));
    const outcome = await listSessions(transport, options);
    expect(outcome).toEqual({ kind: 'invalid-response' });
});

it('rejects the page on a missing time_updated', async () => {
    const { transport } = fakeTransport(
        ok(JSON.stringify([{ id: 'a', title: 't' }])),
    );
    const outcome = await listSessions(transport, options);
    expect(outcome).toEqual({ kind: 'invalid-response' });
});

it('rejects a page longer than the requested limit', () => {
    expect(decodeSessionPage(JSON.parse(sessionsText), 2)).toBeNull();
});

it('skips the length check when limit <= 0', async () => {
    const { transport } = fakeTransport(ok(sessionsText));
    const outcome = await listSessions(transport, { ...options, limit: 0 });
    expect(outcome.kind).toBe('ok');
});

it.each([
    ['non-array body', '{"id":"a"}'],
    ['null body', 'null'],
    ['malformed JSON', '{oops'],
])('maps %s to invalid-response', async (_name, text) => {
    const { transport } = fakeTransport(ok(text));
    const outcome = await listSessions(transport, options);
    expect(outcome).toEqual({ kind: 'invalid-response' });
});

it.each([401, 403])('maps %i to auth-required', async (status) => {
    const { transport } = fakeTransport({
        kind: 'response',
        status,
        text: '',
    });
    const outcome = await listSessions(transport, options);
    expect(outcome).toEqual({ kind: 'auth-required' });
});

it('maps 400 to unsupported-coder', async () => {
    const { transport } = fakeTransport({
        kind: 'response',
        status: 400,
        text: 'Invalid coder',
    });
    const outcome = await listSessions(transport, options);
    expect(outcome).toEqual({ kind: 'unsupported-coder' });
});

it('maps 500 to unavailable', async () => {
    const { transport } = fakeTransport({
        kind: 'response',
        status: 500,
        text: 'boom',
    });
    const outcome = await listSessions(transport, options);
    expect(outcome).toEqual({ kind: 'unavailable' });
});

it('maps transport failure and rejection to unavailable', async () => {
    const failed = fakeTransport({ kind: 'network-failure' });
    expect(await listSessions(failed.transport, options)).toEqual({
        kind: 'unavailable',
    });
    const rejected = fakeTransport(new Error('down'));
    expect(await listSessions(rejected.transport, options)).toEqual({
        kind: 'unavailable',
    });
});

it('maps transport cancellation to cancelled', async () => {
    const { transport } = fakeTransport({ kind: 'cancelled' });
    const outcome = await listSessions(transport, options);
    expect(outcome).toEqual({ kind: 'cancelled' });
});

it('treats an empty array as an empty page', async () => {
    const { transport } = fakeTransport(ok('[]'));
    const outcome = await listSessions(transport, options);
    expect(outcome).toEqual({ kind: 'ok', sessions: [] });
});

it('passes signal and bearer to the transport untouched', async () => {
    const { transport, requests } = fakeTransport(ok('[]'));
    await listSessions(transport, options);
    expect(requests).toHaveLength(1);
    expect(requests[0].signal).toBe(signal);
    expect(requests[0].bearer).toBe('live-token');
    expect(requests[0].method).toBe('GET');
    expect(requests[0].path).toBe(
        '/api/sessions?coder=pi&cwd=%2Ftmp%2Fstage05-probe%2Fws&limit=10&offset=0',
    );
});

it('posts the exact rename method and body', async () => {
    const { transport, requests } = fakeTransport({
        kind: 'response',
        status: 200,
        text: '',
    });
    const outcome = await renameSession(transport, {
        id: 'session-1',
        currentTitle: 'Old',
        name: '  New  ',
        signal,
        bearer: 'live-token',
    });
    expect(outcome).toEqual({ kind: 'ok' });
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('POST');
    expect(requests[0].path).toBe('/api/session-meta');
    expect(requests[0].body).toBe('{"id":"session-1","name":"New"}');
    expect(requests[0].bearer).toBe('live-token');
});

it.each([
    ['empty name', '   '],
    ['unchanged name', 'Old'],
])('short-circuits %s without touching the transport', async (_n, name) => {
    const { transport, requests } = fakeTransport({
        kind: 'response',
        status: 200,
        text: '',
    });
    const outcome = await renameSession(transport, {
        id: 'session-1',
        currentTitle: 'Old',
        name,
        signal,
    });
    expect(outcome).toEqual({ kind: 'unchanged' });
    expect(requests).toHaveLength(0);
});

it('maps rename failures into outcomes', async () => {
    const base = {
        id: 'session-1',
        currentTitle: 'Old',
        name: 'New',
        signal,
    };
    const auth = fakeTransport({ kind: 'response', status: 403, text: '' });
    expect(await renameSession(auth.transport, base)).toEqual({
        kind: 'auth-required',
    });
    const server = fakeTransport({
        kind: 'response',
        status: 500,
        text: 'boom',
    });
    expect(await renameSession(server.transport, base)).toEqual({
        kind: 'unavailable',
    });
    const down = fakeTransport({ kind: 'network-failure' });
    expect(await renameSession(down.transport, base)).toEqual({
        kind: 'unavailable',
    });
    const stopped = fakeTransport({ kind: 'cancelled' });
    expect(await renameSession(stopped.transport, base)).toEqual({
        kind: 'cancelled',
    });
});
