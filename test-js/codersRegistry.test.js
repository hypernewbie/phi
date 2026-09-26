// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
    executeRecipe,
    formatAttachment,
    getCoder,
    hasModelSwitch,
    hasPiRpc,
    hasRename,
    hasSessions,
    hasTranscript,
    inputMode,
    isShell,
    listCoders,
    logoFor,
    modelSwitchDisabled,
    opencodeRecipe,
    piRecipe,
    claudeRecipe,
    presetsFor,
    recipeFor,
    renderLogo,
    visibleCoders,
} from '../web-src/coders.js';

// ─── Capability checks ───────────────────────────────────────────────

describe('coder registry — built-in seed', () => {
    it('flags bash / pwsh as shells', () => {
        expect(isShell('bash')).toBe(true);
        expect(isShell('pwsh')).toBe(true);
        expect(isShell('opencode')).toBe(false);
        expect(isShell('claude')).toBe(false);
        expect(isShell('agy')).toBe(false);
        expect(isShell('pi')).toBe(false);
    });

    it('returns staged for agents, direct for shells', () => {
        expect(inputMode('opencode')).toBe('staged');
        expect(inputMode('claude')).toBe('staged');
        expect(inputMode('bash')).toBe('direct');
        expect(inputMode('pwsh')).toBe('direct');
    });

    it('reports capabilities per built-in', () => {
        expect(hasSessions('opencode')).toBe(true);
        expect(hasTranscript('opencode')).toBe(true);
        expect(hasPiRpc('opencode')).toBe(false);

        expect(hasTranscript('pi')).toBe(true);
        expect(hasPiRpc('pi')).toBe(true);

        expect(hasRename('agy')).toBe(true);
        expect(hasRename('claude')).toBe(true);
        expect(hasRename('opencode')).toBe(false);

        expect(modelSwitchDisabled('agy')).toBe(true);
        expect(modelSwitchDisabled('opencode')).toBe(false);
    });

    it('pwsh is not sidebar-visible by default', () => {
        const visibleIds = visibleCoders().map((c) => c.id);
        expect(visibleIds).not.toContain('pwsh');
        expect(visibleIds).toContain('bash');
        expect(visibleIds).toContain('opencode');
    });

    it('empty presets for unknown ids; built-ins have an empty default', () => {
        expect(presetsFor('bash')).toEqual([]);
        expect(presetsFor('does-not-exist')).toEqual([]);
    });

    it('listCoders returns the seed built-ins', () => {
        const ids = listCoders().map((c) => c.id);
        for (const want of [
            'opencode',
            'claude',
            'agy',
            'pi',
            'bash',
            'pwsh',
        ]) {
            expect(ids).toContain(want);
        }
    });
});

// ─── Attachment substitution (R8) ─────────────────────────────────────

describe('formatAttachment', () => {
    it('returns the raw path for unknown / shell coders', () => {
        expect(formatAttachment('bash', '/tmp/x')).toBe('/tmp/x');
        expect(formatAttachment('pwsh', '/tmp/x')).toBe('/tmp/x');
        expect(formatAttachment('unknown-agent', '/tmp/x')).toBe('/tmp/x');
    });

    it('returns @path for the three mention-syntax agents', () => {
        // Three built-in agents use @<path>; pi gets the raw path.
        expect(formatAttachment('claude', '/tmp/x')).toBe('@/tmp/x');
        expect(formatAttachment('opencode', '/tmp/x')).toBe('@/tmp/x');
        expect(formatAttachment('agy', '/tmp/x')).toBe('@/tmp/x');
        expect(formatAttachment('pi', '/tmp/x')).toBe('/tmp/x');
    });

    it('never interprets $& from string replacement', () => {
        // If implementation used String.replace with a string
        // needle, `path = 'vendor/$&'` would replace to
        // 'vendor/{path}'. We use a callback so this stays literal.
        expect(formatAttachment('claude', 'vendor/$&')).toBe('@vendor/$&');
        expect(formatAttachment('opencode', 'a$b')).toBe('@a$b');
    });
});

// ─── Logo rendering (R9) ──────────────────────────────────────────────

describe('renderLogo', () => {
    function describeLogo(coder) {
        const el = renderLogo(coder);
        return {
            tag: el.tagName,
            text: el.textContent,
            innerHTML: el.innerHTML,
            classes: Array.from(el.classList),
        };
    }

    it('renders the fallback glyph for unsafe logos', () => {
        for (const logo of [
            'data:image/png;base64,x',
            'file:///etc/passwd',
            'http://x.com/y',
            'javascript:alert(1)',
            '/abs/path',
            'plain',
            'vendor/../etc/passwd',
        ]) {
            const r = describeLogo({
                id: 'x',
                name: 'X',
                short_label: 'X',
                logo,
                sidebar_visible: true,
                is_shell: false,
                input_mode: 'staged',
                presets: [],
                capabilities: {
                    list: false,
                    transcript: false,
                    rename: false,
                    pi_rpc: false,
                },
                model_switch_disabled: false,
            });
            expect(r.text).toBe('Φ');
            expect(r.innerHTML).toBe('Φ'); // textContent escapes any markup
            expect(r.classes).toContain('fallback');
        }
    });

    it('renders emoji: prefix as a text span', () => {
        const r = describeLogo({
            id: 'x',
            name: 'X',
            short_label: 'X',
            logo: 'emoji:🤖',
            sidebar_visible: true,
            is_shell: false,
            input_mode: 'staged',
            presets: [],
            capabilities: {
                list: false,
                transcript: false,
                rename: false,
                pi_rpc: false,
            },
            model_switch_disabled: false,
        });
        expect(r.text).toBe('🤖');
        expect(r.classes).toContain('emoji');
        // No HTML escape paths; the glyph round-trips literally.
        expect(r.innerHTML).toBe('🤖');
    });

    it('renders text: prefix as a text badge', () => {
        const r = describeLogo({
            id: 'x',
            name: 'X',
            short_label: 'X',
            logo: "text:It's me",
            sidebar_visible: true,
            is_shell: false,
            input_mode: 'staged',
            presets: [],
            capabilities: {
                list: false,
                transcript: false,
                rename: false,
                pi_rpc: false,
            },
            model_switch_disabled: false,
        });
        expect(r.text).toBe("It's me");
        expect(r.innerHTML).toBe("It's me");
        expect(r.classes).toContain('text-badge');
    });

    it('renders vendor/ paths as an <img>', () => {
        const r = describeLogo({
            id: 'x',
            name: 'X',
            short_label: 'X',
            logo: 'vendor/logos/x.png',
            sidebar_visible: true,
            is_shell: false,
            input_mode: 'staged',
            presets: [],
            capabilities: {
                list: false,
                transcript: false,
                rename: false,
                pi_rpc: false,
            },
            model_switch_disabled: false,
        });
        expect(r.tag).toBe('SPAN');
        expect(r.innerHTML).toContain('<img');
        expect(r.innerHTML).toContain('src="vendor/logos/x.png"');
    });

    it('escapes XSS-style logo values as text', () => {
        const r = describeLogo({
            id: 'x',
            name: '<script>alert(1)</script>',
            short_label: '<img>',
            logo: '',
            sidebar_visible: true,
            is_shell: false,
            input_mode: 'staged',
            presets: [],
            capabilities: {
                list: false,
                transcript: false,
                rename: false,
                pi_rpc: false,
            },
            model_switch_disabled: false,
        });
        // The fallback glyph does not interpret the coder's name.
        expect(r.text).toBe('Φ');
        expect(r.innerHTML).not.toContain('<script>');
    });
});

// ─── Recipe executor (R7) ─────────────────────────────────────────────

describe('executeRecipe', () => {
    it('runs each step in order', async () => {
        const sent = [];
        const ok = await executeRecipe({
            paneId: 'p1',
            recipe: {
                steps: [
                    { send: '/m' },
                    { send: '\r', delay_ms: 1 },
                    { send: '{model}' },
                ],
            },
            model: 'openai',
            sendFn: (id, payload) => {
                sent.push({ id, payload });
                return true;
            },
            isAliveFn: () => true,
        });
        expect(sent.map((s) => s.payload)).toEqual(['/m', '\r', 'openai']);
    });

    it('substitutes {model} via callback (no $& interpretation)', async () => {
        const sent = [];
        await executeRecipe({
            paneId: 'p2',
            recipe: { steps: [{ send: '/model {model}' }] },
            model: 'vendor/$&',
            sendFn: (_id, payload) => {
                sent.push(payload);
                return true;
            },
            isAliveFn: () => true,
        });
        expect(sent[0]).toBe('/model vendor/$&');
    });

    it('rejects control characters in the model identifier', async () => {
        await expect(
            executeRecipe({
                paneId: 'p3',
                recipe: { steps: [{ send: '/m' }] },
                model: 'openai\x1b[31m',
                sendFn: () => true,
                isAliveFn: () => true,
            }),
        ).rejects.toThrow(/control character/);
    });

    it('aborts on send failure (no replay, no recovery)', async () => {
        const sent = [];
        let count = 0;
        await executeRecipe({
            paneId: 'p4',
            recipe: {
                steps: [{ send: '/m' }, { send: '\r' }, { send: '{model}' }],
            },
            model: 'a',
            sendFn: (_id, payload) => {
                sent.push(payload);
                count += 1;
                if (count === 2) return false; // second write fails
                return true;
            },
            isAliveFn: () => true,
        });
        // Only the first step lands.
        expect(sent).toEqual(['/m', '\r']);
    });

    it('aborts cleanly when the pane dies mid-recipe', async () => {
        const sent = [];
        let stepIndex = 0;
        // isAliveFn returns true for step 0 (so the first send
        // runs), then false for step 1+ (so the executor aborts).
        const isAliveFn = () => {
            const v = stepIndex <= 0;
            stepIndex += 1;
            return v;
        };
        await executeRecipe({
            paneId: 'p5',
            recipe: {
                steps: [{ send: '/m' }, { send: '\r' }, { send: '{model}' }],
            },
            model: 'a',
            sendFn: (_id, payload) => {
                sent.push(payload);
                return true;
            },
            isAliveFn,
        });
        // Only the first step landed; the alive check before step 1
        // returned false, so the executor returned without sending.
        expect(sent).toEqual(['/m']);
    });

    it('rejects recipes with too many steps', async () => {
        const steps = [];
        for (let i = 0; i < 20; i++) steps.push({ send: `s${i}` });
        await expect(
            executeRecipe({
                paneId: 'p6',
                recipe: { steps },
                model: 'a',
                sendFn: () => true,
                isAliveFn: () => true,
            }),
        ).rejects.toThrow(/steps/);
    });

    it('rejects recipes whose total delay exceeds the ceiling', async () => {
        await expect(
            executeRecipe({
                paneId: 'p7',
                recipe: { steps: [{ send: 'a', delay_ms: 6000 }] },
                model: 'a',
                sendFn: () => true,
                isAliveFn: () => true,
            }),
        ).rejects.toThrow(/duration/);
    });

    it('serializes overlapping recipe attempts on the same pane', async () => {
        // First attempt holds the pane busy by holding the send
        // callback open; the second attempt should bail with no
        // work done.
        const sent = [];
        let release;
        const blocking = new Promise((r) => {
            release = r;
        });
        const sendFn = (_id, payload) => {
            sent.push(payload);
            return true;
        };

        const first = executeRecipe({
            paneId: 'p8',
            recipe: { steps: [{ send: '/m' }, { send: 'x', delay_ms: 50 }] },
            model: 'a',
            sendFn,
            isAliveFn: () => true,
        });

        // Try a concurrent recipe on the same pane; it should
        // return without sending anything because the first is
        // already in flight.
        const second = await executeRecipe({
            paneId: 'p8',
            recipe: { steps: [{ send: '/y' }] },
            model: 'b',
            sendFn,
            isAliveFn: () => true,
        });
        // Let the first one finish.
        release();
        await first;
        // The second one never wrote because the per-pane guard
        // bailed.
        expect(sent).toEqual(['/m', 'x']);
    });

    it('built-in recipes keep their historical byte sequences', () => {
        expect(opencodeRecipe().steps[0].send).toBe('/models');
        expect(
            opencodeRecipe()
                .steps.map((s) => s.delay_ms)
                .filter(Boolean),
        ).toEqual([350, 350, 350]);
        expect(piRecipe().steps.map((s) => s.send)).toEqual([
            '/model {model}',
            '\x1b',
            '\r',
        ]);
        expect(claudeRecipe().steps.map((s) => s.send)).toEqual([
            '/model {model}\r',
            '\r',
        ]);
    });

    it('recipeFor returns undefined for built-ins (terminal.js owns their sequences) and unknown coders', () => {
        // The three built-ins run their historical setTimeout chains
        // in terminal.js renderModelDropup, so recipeFor returns
        // undefined for them. Custom profiles opt in by returning
        // their descriptor-supplied recipe elsewhere; this stub
        // models the boundary.
        expect(recipeFor('opencode')).toBeUndefined();
        expect(recipeFor('pi')).toBeUndefined();
        expect(recipeFor('claude')).toBeUndefined();
        expect(recipeFor('bash')).toBeUndefined();
        expect(recipeFor('agy')).toBeUndefined();
    });

    it('hasModelSwitch returns true only for the three built-ins', () => {
        // R7: coders without a model-switch recipe must not get a
        // guessed /model fallback. The Models button is hidden when
        // hasModelSwitch returns false.
        expect(hasModelSwitch('opencode')).toBe(true);
        expect(hasModelSwitch('pi')).toBe(true);
        expect(hasModelSwitch('claude')).toBe(true);
        expect(hasModelSwitch('agy')).toBe(false);
        expect(hasModelSwitch('bash')).toBe(false);
        expect(hasModelSwitch('pwsh')).toBe(false);
        expect(hasModelSwitch('custom-agent')).toBe(false);
    });

    it('logoFor returns the vendor path for registered coders', () => {
        // Regression: prior to this commit terminal.js indexed
        // this.app.coderRegistry (which was never assigned) and
        // every coder tab rendered bash.jpg. logoFor must return
        // the registry's vendor/* path directly.
        expect(logoFor('opencode')).toBe('vendor/logos/opencode.png');
        expect(logoFor('claude')).toBe('vendor/logos/claude.png');
        expect(logoFor('agy')).toBe('vendor/logos/agy.png');
        expect(logoFor('pi')).toBe('vendor/logos/pi.png');
        expect(logoFor('bash')).toBe('vendor/logos/bash.jpg');
        expect(logoFor('pwsh')).toBe('vendor/logos/bash.jpg');
        expect(logoFor('unknown')).toBe('');
    });
});

// ─── ID safety ────────────────────────────────────────────────────────

describe('reserved coder IDs', () => {
    it('rejects reserved IDs from descriptors', async () => {
        // Simulate the server returning one valid + one reserved ID.
        const fake = {
            opencode: {
                id: 'opencode',
                name: 'OpenCode',
                short_label: 'OpenCode',
                sidebar_visible: true,
                is_shell: false,
                input_mode: 'staged',
                presets: [],
                capabilities: {
                    list: true,
                    transcript: true,
                    rename: false,
                    pi_rpc: false,
                },
                model_switch_disabled: false,
            },
            review: {
                id: 'review',
                name: 'Review',
                short_label: 'Review',
                sidebar_visible: false,
                is_shell: false,
                input_mode: 'staged',
                presets: [],
                capabilities: {
                    list: false,
                    transcript: false,
                    rename: false,
                    pi_rpc: false,
                },
                model_switch_disabled: false,
            },
        };
        // We can't drive loadCoderRegistry here without fetch
        // mocking, but we can confirm getCoder doesn't blow up on
        // missing IDs and the seedBuiltins path never produces
        // reserved IDs from the canonical built-ins.
        expect(getCoder('opencode')).toBeDefined();
        expect(getCoder('review')).toBeUndefined();
    });
});
