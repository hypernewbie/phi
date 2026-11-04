// Coder registry: seed, decode, and capability readers. Ports
// web-src/coders.ts registry behavior as pure functions over an
// explicit Map; core holds no module state. The caller keeps its
// current map on any non-ok outcome (updateRegistry).
import type {
    AbortSignalLike,
    ApiTransport,
    Capabilities,
    CoderDescriptor,
    CoderRegistry,
    CodersOutcome,
    Preset,
    TransportResult,
} from './types.ts';

// Reserved pseudo-coder ids that must never enter the registry.
// Mirrors pkg/coders.ReservedIDs.
const RESERVED_CODER_IDS = new Set(['review', 'kanban', 'pi-rpc']);

function builtin(
    id: string,
    name: string,
    short_label: string,
    logo: string,
    sidebar_visible: boolean,
    is_shell: boolean,
    input_mode: 'staged' | 'direct',
    capabilities: Capabilities,
    model_switch_disabled: boolean,
): CoderDescriptor {
    return {
        id,
        name,
        short_label,
        logo,
        sidebar_visible,
        is_shell,
        input_mode,
        presets: [],
        capabilities,
        model_switch_disabled,
    };
}

// The canonical built-ins, verbatim from legacy seedBuiltins. Powers
// capability checks before the registry read resolves, and stays in
// place when the read fails.
export function seedBuiltins(): CoderRegistry {
    return new Map([
        [
            'opencode',
            builtin(
                'opencode',
                'OpenCode',
                'OpenCode',
                'vendor/logos/opencode.png',
                true,
                false,
                'staged',
                { list: true, transcript: true, rename: false, pi_rpc: false },
                false,
            ),
        ],
        [
            'claude',
            builtin(
                'claude',
                'Claude Code',
                'Claude',
                'vendor/logos/claude.png',
                true,
                false,
                'staged',
                { list: true, transcript: false, rename: true, pi_rpc: false },
                false,
            ),
        ],
        [
            'agy',
            builtin(
                'agy',
                'Antigravity',
                'Agy',
                'vendor/logos/agy.png',
                true,
                false,
                'staged',
                { list: true, transcript: false, rename: true, pi_rpc: false },
                true,
            ),
        ],
        [
            'pi',
            builtin(
                'pi',
                'Pi Coder',
                'Pi',
                'vendor/logos/pi.png',
                true,
                false,
                'staged',
                { list: true, transcript: true, rename: false, pi_rpc: true },
                false,
            ),
        ],
        [
            'codex',
            builtin(
                'codex',
                'Codex',
                'Codex',
                'vendor/logos/codex.png',
                true,
                false,
                'staged',
                {
                    list: true,
                    transcript: false,
                    rename: false,
                    pi_rpc: false,
                },
                false,
            ),
        ],
        [
            'bash',
            builtin(
                'bash',
                'Shell',
                'Shell',
                'vendor/logos/bash.jpg',
                true,
                true,
                'direct',
                {
                    list: false,
                    transcript: false,
                    rename: false,
                    pi_rpc: false,
                },
                false,
            ),
        ],
        [
            'pwsh',
            builtin(
                'pwsh',
                'PowerShell',
                'PowerShell',
                'vendor/logos/bash.jpg',
                false,
                true,
                'direct',
                {
                    list: false,
                    transcript: false,
                    rename: false,
                    pi_rpc: false,
                },
                false,
            ),
        ],
    ]);
}

function coerceCapabilities(raw: unknown): Capabilities {
    if (typeof raw !== 'object' || raw === null)
        return { list: false, transcript: false, rename: false, pi_rpc: false };
    const flags = raw as Record<string, unknown>;
    return {
        list: flags.list === true,
        transcript: flags.transcript === true,
        rename: flags.rename === true,
        pi_rpc: flags.pi_rpc === true,
    };
}

function coercePresets(raw: unknown): Preset[] {
    if (!Array.isArray(raw)) return [];
    const out: Preset[] = [];
    for (const item of raw) {
        if (
            typeof item === 'object' &&
            item !== null &&
            typeof (item as Record<string, unknown>).name === 'string' &&
            typeof (item as Record<string, unknown>).value === 'string'
        )
            out.push({
                name: (item as Record<string, unknown>).name as string,
                value: (item as Record<string, unknown>).value as string,
            });
    }
    return out;
}

function coerceDescriptor(
    id: string,
    raw: unknown,
): CoderDescriptor | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const entry = raw as Record<string, unknown>;
    if (RESERVED_CODER_IDS.has(id)) return null;
    if (typeof entry.name !== 'string' || entry.name === '') return null;
    const name = entry.name;
    const order =
        typeof entry.order === 'number' &&
        Number.isSafeInteger(entry.order) &&
        entry.order >= 0
            ? entry.order
            : undefined;
    const opencode_mode =
        entry.opencode_mode === 'mini' ||
        entry.opencode_mode === 'tui' ||
        entry.opencode_mode === 'legacy'
            ? entry.opencode_mode
            : undefined;
    return {
        id,
        ...(order === undefined ? {} : { order }),
        name,
        short_label:
            typeof entry.short_label === 'string'
                ? entry.short_label
                : name.split(/\s+/)[0],
        logo: typeof entry.logo === 'string' && entry.logo ? entry.logo : '',
        sidebar_visible: entry.sidebar_visible === true,
        is_shell: entry.is_shell === true,
        input_mode:
            entry.input_mode === 'staged' || entry.input_mode === 'direct'
                ? entry.input_mode
                : 'staged',
        presets: coercePresets(entry.presets),
        capabilities: coerceCapabilities(entry.capabilities),
        model_switch_disabled: entry.model_switch_disabled === true,
        ...(opencode_mode === undefined ? {} : { opencode_mode }),
        opencode_mini_presets: coercePresets(entry.opencode_mini_presets),
        ...(typeof entry.pi_mode === 'string'
            ? { pi_mode: entry.pi_mode }
            : {}),
    };
}

// Decodes an /api/coders body in either wire shape: the array form or
// the ID-keyed object form. In object form the KEY is the id (an
// embedded id field is ignored); in array form the entry needs a
// string non-empty id. Invalid entries are skipped, never fatal.
// Returns null only when the top level is neither shape.
export function decodeCoderRegistry(data: unknown): CoderDescriptor[] | null {
    const out: CoderDescriptor[] = [];
    if (Array.isArray(data)) {
        for (const item of data) {
            if (typeof item !== 'object' || item === null) continue;
            const id = (item as Record<string, unknown>).id;
            if (typeof id !== 'string' || id === '') continue;
            const descriptor = coerceDescriptor(id, item);
            if (descriptor !== null) out.push(descriptor);
        }
        return out;
    }
    if (typeof data === 'object' && data !== null) {
        for (const [id, raw] of Object.entries(
            data as Record<string, unknown>,
        )) {
            const descriptor = coerceDescriptor(id, raw);
            if (descriptor !== null) out.push(descriptor);
        }
        return out;
    }
    return null;
}

export interface FetchCoderRegistryOptions {
    readonly signal: AbortSignalLike;
    readonly bearer?: string;
}

// Reads /api/coders through the injected transport. Same no-throw
// invariant as the session wrappers.
export async function fetchCoderRegistry(
    transport: ApiTransport,
    options: FetchCoderRegistryOptions,
): Promise<CodersOutcome> {
    let result: TransportResult;
    try {
        result = await transport({
            method: 'GET',
            path: '/api/coders',
            signal: options.signal,
            bearer: options.bearer,
        });
    } catch {
        return { kind: 'unavailable' };
    }
    if (result.kind === 'cancelled') return { kind: 'cancelled' };
    if (result.kind === 'network-failure') return { kind: 'unavailable' };
    if (result.status === 401 || result.status === 403)
        return { kind: 'auth-required' };
    if (result.status !== 200) return { kind: 'unavailable' };
    let data: unknown;
    try {
        data = JSON.parse(result.text);
    } catch {
        return { kind: 'invalid-response' };
    }
    const descriptors = decodeCoderRegistry(data);
    if (descriptors === null) return { kind: 'invalid-response' };
    return { kind: 'ok', descriptors };
}

// Applies a registry read to the current map: ok replaces (even with
// zero descriptors — the server said zero), any other outcome keeps
// the current map object unchanged. A failed read never erases
// capabilities.
export function updateRegistry(
    current: CoderRegistry,
    outcome: CodersOutcome,
): CoderRegistry {
    if (outcome.kind !== 'ok') return current;
    return new Map(outcome.descriptors.map((d) => [d.id, d]));
}

export function getCoder(
    registry: CoderRegistry,
    id: string,
): CoderDescriptor | undefined {
    return registry.get(id);
}

export function listCoders(registry: CoderRegistry): CoderDescriptor[] {
    // A JSON object cannot preserve the registry's insertion order:
    // encoding/json sorts its keys. Entries without an order field
    // keep their arrival order (stable sort).
    return Array.from(registry.values()).sort(
        (a, b) =>
            (a.order ?? Number.MAX_SAFE_INTEGER) -
            (b.order ?? Number.MAX_SAFE_INTEGER),
    );
}

export function visibleCoders(registry: CoderRegistry): CoderDescriptor[] {
    return listCoders(registry).filter((c) => c.sidebar_visible);
}

export function isShell(registry: CoderRegistry, id: string): boolean {
    return registry.get(id)?.is_shell === true;
}

export function inputMode(
    registry: CoderRegistry,
    id: string,
): 'staged' | 'direct' {
    return registry.get(id)?.input_mode === 'direct' ? 'direct' : 'staged';
}

export function presetsFor(
    registry: CoderRegistry,
    id: string,
): Preset[] {
    return registry.get(id)?.presets ?? [];
}

export function hasTranscript(registry: CoderRegistry, id: string): boolean {
    return registry.get(id)?.capabilities.transcript === true;
}

export function hasPiRpc(registry: CoderRegistry, id: string): boolean {
    return registry.get(id)?.capabilities.pi_rpc === true;
}

export function hasRename(registry: CoderRegistry, id: string): boolean {
    return registry.get(id)?.capabilities.rename === true;
}

export function hasSessions(registry: CoderRegistry, id: string): boolean {
    return registry.get(id)?.capabilities.list === true;
}

export function modelSwitchDisabled(
    registry: CoderRegistry,
    id: string,
): boolean {
    return registry.get(id)?.model_switch_disabled === true;
}

// Returns the vendor logo path, or '' when the registry has none or
// the value is not a plain vendor/ relative path. Callers fall back
// to their own default glyph.
export function logoFor(registry: CoderRegistry, id: string): string {
    const logo = registry.get(id)?.logo;
    if (typeof logo !== 'string' || !logo) return '';
    if (logo.startsWith('vendor/') && !logo.includes('..')) return logo;
    return '';
}
