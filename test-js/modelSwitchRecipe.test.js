// @vitest-environment jsdom
//
// Declarative model-switch recipes for custom backends.
//
// A backend file in ~/.phi/backends/ may declare a bounded recipe:
//
//   { "id": "gemini", "model_switch": [{"send": "/model set {model}\r"}] }
//
// The server validates it (pkg/coders ValidateModelSwitch) and serves
// it in the descriptor. The client validates it again with the same
// bounds before the bounded executor runs it, so a malformed recipe
// disables the Models button instead of guessing a command.

import { describe, expect, it, beforeEach } from 'vitest';
import {
    executeRecipe,
    hasModelSwitch,
    rebuildRegistry,
    recipeFor,
} from '../web-src/coders.js';

function descriptor(overrides = {}) {
    return {
        id: 'gem',
        name: 'Gem',
        short_label: 'Gem',
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
        ...overrides,
    };
}

beforeEach(() => {
    rebuildRegistry({ gem: descriptor() });
});

describe('declarative model_switch recipes', () => {
    it('enables the Models button for a custom backend with a recipe', () => {
        rebuildRegistry({
            gem: descriptor({
                model_switch: {
                    steps: [{ send: '/model set {model}\r' }],
                },
            }),
        });
        expect(hasModelSwitch('gem')).toBe(true);
        expect(recipeFor('gem')?.steps.map((s) => s.send)).toEqual([
            '/model set {model}\r',
        ]);
    });

    it('accepts the bare-steps array form', () => {
        rebuildRegistry({
            gem: descriptor({
                model_switch: [{ send: '/model set {model}\r' }],
            }),
        });
        expect(hasModelSwitch('gem')).toBe(true);
        expect(recipeFor('gem')?.steps).toHaveLength(1);
    });

    it('leaves the Models button disabled without a recipe', () => {
        expect(hasModelSwitch('gem')).toBe(false);
        expect(recipeFor('gem')).toBeUndefined();
    });

    it('honours model_switch_disabled over a declared recipe', () => {
        rebuildRegistry({
            gem: descriptor({
                model_switch_disabled: true,
                model_switch: { steps: [{ send: '/model set {model}\r' }] },
            }),
        });
        expect(hasModelSwitch('gem')).toBe(false);
        expect(recipeFor('gem')).toBeUndefined();
    });

    it('drops malformed recipes instead of guessing a command', () => {
        const bad = [
            { steps: [] },
            { steps: [{ send: '' }] },
            { steps: [{ send: '/x', delay_ms: -1 }] },
            { steps: [{ send: '/x', delay_ms: 1.5 }] },
            { steps: [{ send: 'x'.repeat(257) }] },
            { steps: Array.from({ length: 9 }, () => ({ send: '/x' })) },
            {
                steps: [
                    { send: '/a', delay_ms: 4000 },
                    { send: '/b', delay_ms: 4000 },
                ],
            },
            'not-an-object',
        ];
        for (const model_switch of bad) {
            rebuildRegistry({ gem: descriptor({ model_switch }) });
            expect(hasModelSwitch('gem'), JSON.stringify(model_switch)).toBe(
                false,
            );
            expect(recipeFor('gem')).toBeUndefined();
        }
    });

    it('runs a declared recipe through the bounded executor', async () => {
        rebuildRegistry({
            gem: descriptor({
                model_switch: {
                    steps: [
                        { send: '/model set {model}\r' },
                        { send: '\x1b', delay_ms: 200 },
                        { send: '\r', delay_ms: 200 },
                    ],
                },
            }),
        });
        const sent = [];
        await executeRecipe({
            paneId: 'pane-1',
            recipe: recipeFor('gem'),
            model: 'gemini-3.1-pro-preview',
            sendFn: (_id, payload) => {
                sent.push(payload);
                return true;
            },
            isAliveFn: () => true,
        });
        expect(sent).toEqual([
            '/model set gemini-3.1-pro-preview\r',
            '\x1b',
            '\r',
        ]);
    });

    it('rejects a model identifier carrying control characters', async () => {
        rebuildRegistry({
            gem: descriptor({
                model_switch: { steps: [{ send: '/model set {model}\r' }] },
            }),
        });
        await expect(
            executeRecipe({
                paneId: 'pane-1',
                recipe: recipeFor('gem'),
                model: 'bad\x1bmodel',
                sendFn: () => true,
                isAliveFn: () => true,
            }),
        ).rejects.toThrow(/control characters/);
    });
});
