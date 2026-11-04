import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
    decodeCoderRegistry,
    fetchCoderRegistry,
    getCoder,
    hasPiRpc,
    hasRename,
    hasSessions,
    hasTranscript,
    inputMode,
    isShell,
    listCoders,
    logoFor,
    modelSwitchDisabled,
    presetsFor,
    seedBuiltins,
    updateRegistry,
    visibleCoders,
} from '../../src/api/coders.ts';
import type {
    ApiRequest,
    ApiTransport,
    Capabilities,
    TransportResult,
} from '../../src/api/types.ts';

const fixtureDir = fileURLToPath(new URL('../fixtures/', import.meta.url));
const codersText = readFileSync(fixtureDir + 'coders.json', 'utf8');

const signal = { aborted: false };

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

it('seeds exactly the seven legacy built-ins', () => {
    const seed = seedBuiltins();
    expect([...seed.keys()]).toEqual([
        'opencode',
        'claude',
        'agy',
        'pi',
        'codex',
        'bash',
        'pwsh',
    ]);
    const matrix: Record<string, Capabilities> = {
        opencode: { list: true, transcript: true, rename: false, pi_rpc: false },
        claude: { list: true, transcript: false, rename: true, pi_rpc: false },
        agy: { list: true, transcript: false, rename: true, pi_rpc: false },
        pi: { list: true, transcript: true, rename: false, pi_rpc: true },
        codex: { list: true, transcript: false, rename: false, pi_rpc: false },
        bash: { list: false, transcript: false, rename: false, pi_rpc: false },
        pwsh: { list: false, transcript: false, rename: false, pi_rpc: false },
    };
    for (const [id, capabilities] of Object.entries(matrix))
        expect(seed.get(id)?.capabilities).toEqual(capabilities);
    expect(seed.get('agy')?.model_switch_disabled).toBe(true);
    expect(seed.get('pi')?.model_switch_disabled).toBe(false);
    expect(seed.get('bash')?.is_shell).toBe(true);
    expect(seed.get('bash')?.input_mode).toBe('direct');
    expect(seed.get('pwsh')?.sidebar_visible).toBe(false);
});

it('decodes object and array forms with legacy defaults', () => {
    const fromObject = decodeCoderRegistry(JSON.parse(codersText));
    expect(fromObject?.map((d) => d.id).sort()).toEqual([
        'custom-minimal',
        'keyed',
        'pi',
    ]);
    const minimal = fromObject?.find((d) => d.id === 'custom-minimal');
    expect(minimal).toMatchObject({
        name: 'Custom Minimal',
        short_label: 'Custom',
        input_mode: 'staged',
        capabilities: {
            list: false,
            transcript: false,
            rename: false,
            pi_rpc: false,
        },
    });
    const keyed = fromObject?.find((d) => d.id === 'keyed');
    expect(keyed?.name).toBe('Key Wins');
    const pi = fromObject?.find((d) => d.id === 'pi');
    expect('env' in (pi as object)).toBe(false);
    expect('command' in (pi as object)).toBe(false);
    expect(pi?.pi_mode).toBe('rpc');
    const fromArray = decodeCoderRegistry([
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B Coder' },
    ]);
    expect(fromArray?.map((d) => d.id)).toEqual(['a', 'b']);
    expect(fromArray?.[1].short_label).toBe('B');
});

it('skips invalid entries and keeps the survivors', () => {
    const decoded = decodeCoderRegistry({
        good: { name: 'Good' },
        'pi-rpc': { name: 'Reserved' },
        review: { name: 'Reserved' },
        noname: { order: 1 },
        emptyname: { name: '' },
        notobject: 42,
    });
    expect(decoded?.map((d) => d.id)).toEqual(['good']);
    const arrayMissingIds = decodeCoderRegistry([
        { name: 'No id' },
        { id: '', name: 'Empty id' },
        { id: 7, name: 'Numeric id' },
        'garbage',
        null,
        { id: 'kept', name: 'Kept' },
    ]);
    expect(arrayMissingIds?.map((d) => d.id)).toEqual(['kept']);
});

it.each([['string', '"x"'], ['number', '7'], ['null', 'null']])(
    'decodes garbage top-level %s to null',
    (_name, text) => {
        expect(decodeCoderRegistry(JSON.parse(text))).toBeNull();
    },
);

it('replaces on ok and keeps the identical map otherwise', () => {
    const seed = seedBuiltins();
    const replaced = updateRegistry(seed, { kind: 'ok', descriptors: [] });
    expect(replaced.size).toBe(0);
    expect(replaced).not.toBe(seed);
    for (const kind of [
        'unavailable',
        'invalid-response',
        'auth-required',
        'cancelled',
    ] as const)
        expect(updateRegistry(seed, { kind })).toBe(seed);
});

it('sorts by order, stable without it, and filters visibility', () => {
    const descriptors = decodeCoderRegistry([
        { id: 'second', name: 'Second', order: 2 },
        { id: 'first', name: 'First', order: 1 },
        { id: 'unordered-b', name: 'Unordered B' },
        { id: 'unordered-a', name: 'Unordered A' },
    ]);
    if (descriptors === null) throw new Error('fixture must decode');
    const registry = updateRegistry(seedBuiltins(), {
        kind: 'ok',
        descriptors,
    });
    expect(listCoders(registry).map((d) => d.id)).toEqual([
        'first',
        'second',
        'unordered-b',
        'unordered-a',
    ]);
    expect(visibleCoders(seedBuiltins()).map((d) => d.id)).not.toContain(
        'pwsh',
    );
    expect(visibleCoders(seedBuiltins())).toHaveLength(6);
});

it('reads seed capabilities through the capability readers', () => {
    const seed = seedBuiltins();
    expect(hasTranscript(seed, 'pi')).toBe(true);
    expect(hasPiRpc(seed, 'pi')).toBe(true);
    expect(hasRename(seed, 'pi')).toBe(false);
    expect(hasSessions(seed, 'pi')).toBe(true);
    expect(hasRename(seed, 'agy')).toBe(true);
    expect(modelSwitchDisabled(seed, 'agy')).toBe(true);
    expect(modelSwitchDisabled(seed, 'pi')).toBe(false);
    expect(isShell(seed, 'bash')).toBe(true);
    expect(isShell(seed, 'pi')).toBe(false);
    expect(inputMode(seed, 'bash')).toBe('direct');
    expect(inputMode(seed, 'pi')).toBe('staged');
    expect(getCoder(seed, 'codex')?.name).toBe('Codex');
    expect(presetsFor(seed, 'pi')).toEqual([]);
    expect(logoFor(seed, 'pi')).toBe('vendor/logos/pi.png');
});

it('coerces invalid field values to safe defaults', () => {
    const decoded = decodeCoderRegistry([
        {
            id: 'coerced',
            name: 'Coerced',
            order: -1,
            input_mode: 'weird',
            opencode_mode: 'weird',
            pi_mode: 42,
            logo: 42,
            presets: [
                { name: 'good', value: 'g' },
                { name: 'missing-value' },
                { name: 7, value: 'v' },
                'garbage',
                null,
            ],
            capabilities: { list: 'yes', transcript: 1 },
        },
        { id: 'float-order', name: 'Float Order', order: 1.5 },
    ]);
    if (decoded === null) throw new Error('fixture must decode');
    const coerced = decoded.find((d) => d.id === 'coerced');
    expect(coerced).toMatchObject({
        input_mode: 'staged',
        logo: '',
        presets: [{ name: 'good', value: 'g' }],
        capabilities: {
            list: false,
            transcript: false,
            rename: false,
            pi_rpc: false,
        },
    });
    expect(coerced).not.toHaveProperty('order');
    expect(coerced).not.toHaveProperty('opencode_mode');
    expect(coerced).not.toHaveProperty('pi_mode');
    const floated = decoded.find((d) => d.id === 'float-order');
    expect(floated).not.toHaveProperty('order');
});

it('reads decoded presets through presetsFor', () => {
    const descriptors = decodeCoderRegistry(JSON.parse(codersText));
    if (descriptors === null) throw new Error('fixture must decode');
    const registry = updateRegistry(seedBuiltins(), {
        kind: 'ok',
        descriptors,
    });
    expect(presetsFor(registry, 'pi')).toEqual([
        { name: 'default', value: 'pi' },
    ]);
});

it('rejects non-vendor and traversal logos', () => {
    const descriptors = decodeCoderRegistry([
        { id: 'ok', name: 'Ok', logo: 'vendor/logos/pi.png' },
        { id: 'trav', name: 'Traversal', logo: 'vendor/../secret.png' },
        { id: 'http', name: 'Http', logo: 'http://x/y.png' },
        { id: 'data', name: 'Data', logo: 'data:image/png,xx' },
        { id: 'abs', name: 'Absolute', logo: '/etc/passwd' },
        { id: 'empty', name: 'Empty', logo: '' },
    ]);
    if (descriptors === null) throw new Error('fixture must decode');
    const registry = updateRegistry(seedBuiltins(), {
        kind: 'ok',
        descriptors,
    });
    expect(logoFor(registry, 'ok')).toBe('vendor/logos/pi.png');
    for (const id of ['trav', 'http', 'data', 'abs', 'empty'])
        expect(logoFor(registry, id)).toBe('');
});

it('returns safe defaults for unknown ids', () => {
    const seed = seedBuiltins();
    expect(getCoder(seed, 'nope')).toBeUndefined();
    expect(hasTranscript(seed, 'nope')).toBe(false);
    expect(hasPiRpc(seed, 'nope')).toBe(false);
    expect(hasRename(seed, 'nope')).toBe(false);
    expect(hasSessions(seed, 'nope')).toBe(false);
    expect(isShell(seed, 'nope')).toBe(false);
    expect(inputMode(seed, 'nope')).toBe('staged');
    expect(presetsFor(seed, 'nope')).toEqual([]);
    expect(modelSwitchDisabled(seed, 'nope')).toBe(false);
    expect(logoFor(seed, 'nope')).toBe('');
});

it('falls back when optional descriptor fields are absent', () => {
    const descriptors = decodeCoderRegistry([
        { id: 'bare', name: 'Bare' },
    ]);
    if (descriptors === null) throw new Error('fixture must decode');
    const bare = descriptors[0];
    const registry = new Map([
        ['bare', { ...bare, logo: undefined, presets: undefined }],
    ]);
    expect(logoFor(registry, 'bare')).toBe('');
    expect(presetsFor(registry, 'bare')).toEqual([]);
});

it('reads the registry through the injected transport', async () => {
    const { transport, requests } = fakeTransport(ok(codersText));
    const outcome = await fetchCoderRegistry(transport, {
        signal,
        bearer: 'live-token',
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.descriptors.map((d) => d.id).sort()).toEqual([
        'custom-minimal',
        'keyed',
        'pi',
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
        method: 'GET',
        path: '/api/coders',
        bearer: 'live-token',
    });
    expect(requests[0].signal).toBe(signal);
});

it.each([401, 403])('maps registry %i to auth-required', async (status) => {
    const auth = fakeTransport({ kind: 'response', status, text: '' });
    expect(await fetchCoderRegistry(auth.transport, { signal })).toEqual({
        kind: 'auth-required',
    });
});

it('maps registry failures into outcomes', async () => {
    const garbage = fakeTransport(ok('"just-a-string"'));
    expect(await fetchCoderRegistry(garbage.transport, { signal })).toEqual({
        kind: 'invalid-response',
    });
    const broken = fakeTransport(ok('{oops'));
    expect(await fetchCoderRegistry(broken.transport, { signal })).toEqual({
        kind: 'invalid-response',
    });
    const server = fakeTransport({
        kind: 'response',
        status: 500,
        text: 'boom',
    });
    expect(await fetchCoderRegistry(server.transport, { signal })).toEqual({
        kind: 'unavailable',
    });
    const down = fakeTransport({ kind: 'network-failure' });
    expect(await fetchCoderRegistry(down.transport, { signal })).toEqual({
        kind: 'unavailable',
    });
    const rejected = fakeTransport(new Error('down'));
    expect(await fetchCoderRegistry(rejected.transport, { signal })).toEqual({
        kind: 'unavailable',
    });
    const stopped = fakeTransport({ kind: 'cancelled' });
    expect(await fetchCoderRegistry(stopped.transport, { signal })).toEqual({
        kind: 'cancelled',
    });
});
