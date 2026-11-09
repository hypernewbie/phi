// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import {
    getCoder,
    hasModelSwitch,
    hasSessions,
    formatAttachment,
    modelSwitchDisabled,
    agyRecipe,
    executeRecipe,
} from '../web/coders.js';
import {
    getCoder as getCoderSrc,
    hasModelSwitch as hasModelSwitchSrc,
    modelSwitchDisabled as modelSwitchDisabledSrc,
    agyRecipe as agyRecipeSrc,
} from '../web-src/coders.js';

setupDomHarness();

describe('Antigravity (agy) model support', () => {
    it('seeds a visible staged backend with model switching enabled', () => {
        for (const [gc, hms, msd] of [
            [getCoder, hasModelSwitch, modelSwitchDisabled],
            [getCoderSrc, hasModelSwitchSrc, modelSwitchDisabledSrc],
        ]) {
            const coder = gc('agy');
            expect(coder).toBeDefined();
            expect(coder.sidebar_visible).toBe(true);
            expect(coder.input_mode).toBe('staged');
            expect(hasSessions('agy')).toBe(true);
            expect(hms('agy')).toBe(true);
            expect(msd('agy')).toBe(false);
            expect(formatAttachment('agy', '/project/main.go')).toBe('@/project/main.go');
        }
    });

    it('agyRecipe generates canonical /model {model}\\r command', () => {
        const recipe = agyRecipe();
        expect(recipe.steps).toHaveLength(1);
        expect(recipe.steps[0].send).toBe('/model {model}\r');
        expect(recipe.steps[0].delay_ms).toBeUndefined();
    });

    it('executeRecipe executes agy model switch cleanly against target pane', async () => {
        const sent = [];
        const sendFn = vi.fn((paneId, payload) => {
            sent.push({ paneId, payload });
            return true;
        });
        const isAliveFn = vi.fn(() => true);

        await executeRecipe({
            paneId: 'pane-agy-1',
            recipe: agyRecipe(),
            model: 'gemini-4-argon-high',
            sendFn,
            isAliveFn,
        });

        expect(sendFn).toHaveBeenCalledTimes(1);
        expect(sent).toEqual([
            { paneId: 'pane-agy-1', payload: '/model gemini-4-argon-high\r' },
        ]);
    });
});
