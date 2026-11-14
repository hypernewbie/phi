// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
    getCoder,
    listCoders,
    rebuildRegistry,
    seedBuiltins,
} from '../web/coders.js';

// The registry is the single source of truth for tabs, sessions, and recipes.
// The server payload is untrusted, so each field has a defined fallback and a
// broken entry must never take the other coders down with it.
beforeEach(() => {
    seedBuiltins();
});

const descriptor = (patch = {}) => ({
    name: 'Claude Code',
    short_label: 'Claude',
    logo: 'claude',
    sidebar_visible: true,
    is_shell: false,
    input_mode: 'direct',
    capabilities: {
        list: true,
        transcript: true,
        rename: true,
        pi_rpc: false,
    },
    ...patch,
});

describe('rebuildRegistry', () => {
    it('keeps the registry usable when the payload is not a map or list', () => {
        rebuildRegistry(null);
        expect(listCoders()).toEqual([]);
        rebuildRegistry('nonsense');
        expect(listCoders()).toEqual([]);
        rebuildRegistry(42);
        expect(listCoders()).toEqual([]);
    });

    it('drops only the unusable entry of a map payload', () => {
        rebuildRegistry({
            claude: descriptor(),
            broken: { name: '' },
            alsoBroken: { logo: 'x' },
        });
        expect(listCoders().map((c) => c.id)).toEqual(['claude']);
        expect(getCoder('broken')).toBeUndefined();
    });

    it('skips a list entry that has no id', () => {
        rebuildRegistry([
            { id: 'claude', ...descriptor() },
            { ...descriptor({ name: 'Orphan' }) },
        ]);
        expect(listCoders().map((c) => c.id)).toEqual(['claude']);
    });

    it('refuses a reserved id so the registry cannot be shadowed', () => {
        rebuildRegistry({ review: descriptor(), claude: descriptor() });
        expect(listCoders().map((c) => c.id)).toEqual(['claude']);
    });

    it('defaults short_label from the first word of name', () => {
        rebuildRegistry({ claude: descriptor({ short_label: undefined }) });
        expect(getCoder('claude')?.short_label).toBe('Claude');

        rebuildRegistry({
            claude: descriptor({
                name: 'Pi  Coding Agent',
                short_label: undefined,
            }),
        });
        expect(getCoder('claude')?.short_label).toBe('Pi');
    });

    it('keeps a deliberately empty short_label', () => {
        rebuildRegistry({ claude: descriptor({ short_label: '' }) });
        expect(getCoder('claude')?.short_label).toBe('');
    });

    it('falls back to an empty logo instead of dropping the coder', () => {
        rebuildRegistry({ claude: descriptor({ logo: 123 }) });
        expect(getCoder('claude')?.logo).toBe('');
        rebuildRegistry({ claude: descriptor({ logo: '' }) });
        expect(getCoder('claude')?.logo).toBe('');
    });

    it('keeps only a non-negative safe integer order', () => {
        rebuildRegistry({ claude: descriptor({ order: 3 }) });
        expect(getCoder('claude')?.order).toBe(3);
        for (const bad of [-1, 1.5, '2', Number.NaN, 2 ** 53]) {
            rebuildRegistry({ claude: descriptor({ order: bad }) });
            expect(getCoder('claude')?.order, String(bad)).toBeUndefined();
        }
    });

    it('treats only a literal true as enabled', () => {
        rebuildRegistry({
            claude: descriptor({
                sidebar_visible: 'yes',
                is_shell: 1,
                model_switch_disabled: 'true',
            }),
        });
        const coder = getCoder('claude');
        expect(coder?.sidebar_visible).toBe(false);
        expect(coder?.is_shell).toBe(false);
        expect(coder?.model_switch_disabled).toBe(false);
    });

    it('defaults input_mode to staged and opencode_mode to unset', () => {
        rebuildRegistry({
            claude: descriptor({ input_mode: 'weird', opencode_mode: 'weird' }),
        });
        expect(getCoder('claude')?.input_mode).toBe('staged');
        expect(getCoder('claude')?.opencode_mode).toBeUndefined();

        for (const mode of ['staged', 'direct']) {
            rebuildRegistry({ claude: descriptor({ input_mode: mode }) });
            expect(getCoder('claude')?.input_mode).toBe(mode);
        }
        for (const mode of ['tui', 'mini', 'legacy']) {
            rebuildRegistry({ claude: descriptor({ opencode_mode: mode }) });
            expect(getCoder('claude')?.opencode_mode).toBe(mode);
        }
    });

    it('defaults the optional collections of a bare entry', () => {
        rebuildRegistry({ claude: { name: 'Bare' } });
        expect(getCoder('claude')).toMatchObject({
            presets: [],
            opencode_mini_presets: [],
            capabilities: {
                list: false,
                transcript: false,
                rename: false,
                pi_rpc: false,
            },
            logo: '',
            short_label: 'Bare',
            input_mode: 'staged',
            sidebar_visible: false,
            is_shell: false,
            model_switch_disabled: false,
        });
    });

    it('turns a malformed capabilities field into all-false', () => {
        rebuildRegistry({ claude: descriptor({ capabilities: 123 }) });
        expect(getCoder('claude')?.capabilities).toEqual({
            list: false,
            transcript: false,
            rename: false,
            pi_rpc: false,
        });
    });

    it('keeps a capability only when it is literally true', () => {
        rebuildRegistry({
            claude: descriptor({
                capabilities: {
                    list: true,
                    transcript: 'yes',
                    rename: 1,
                    pi_rpc: false,
                },
            }),
        });
        expect(getCoder('claude')?.capabilities).toEqual({
            list: true,
            transcript: false,
            rename: false,
            pi_rpc: false,
        });
    });

    it('gives every coder its own presets and capabilities', () => {
        // Fallback values must not be shared: one coder's array must not be
        // another coder's array, or a later sort/splice corrupts both.
        rebuildRegistry({
            a: descriptor({ presets: 'broken', capabilities: 'broken' }),
            b: descriptor({ presets: 'broken', capabilities: 'broken' }),
        });
        const a = getCoder('a');
        const b = getCoder('b');
        expect(a?.presets).not.toBe(b?.presets);
        expect(a?.capabilities).not.toBe(b?.capabilities);
        a?.presets?.push({ name: 'x', value: 'y' });
        if (a) a.capabilities.list = true;
        expect(b?.presets).toEqual([]);
        expect(b?.capabilities.list).toBe(false);
    });

    it('drops unusable presets but keeps the coder', () => {
        rebuildRegistry({
            claude: descriptor({
                presets: [
                    { name: 'opus', value: 'opus' },
                    { name: 'no-value' },
                    null,
                    'junk',
                ],
                opencode_mini_presets: 7,
            }),
        });
        expect(getCoder('claude')?.presets).toEqual([
            { name: 'opus', value: 'opus' },
        ]);
        expect(getCoder('claude')?.opencode_mini_presets).toEqual([]);
    });

    it('keeps pi_mode only when it is a string', () => {
        rebuildRegistry({ claude: descriptor({ pi_mode: 'psi' }) });
        expect(getCoder('claude')?.pi_mode).toBe('psi');
        rebuildRegistry({ claude: descriptor({ pi_mode: 7 }) });
        expect(getCoder('claude')?.pi_mode).toBeUndefined();
    });

    it('strips unknown fields so they cannot leak into the UI', () => {
        rebuildRegistry({
            claude: descriptor({ command: 'rm -rf /', default_cwd: '/etc' }),
        });
        const coder = getCoder('claude');
        expect(coder && Object.hasOwn(coder, 'command')).toBe(false);
        expect(coder && Object.hasOwn(coder, 'default_cwd')).toBe(false);
    });
});
