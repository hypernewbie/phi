import { describe, it, expect } from 'vitest';
import {
    getTerminalActivityState,
    phiActivityGlyph,
    formatTerminalActivityTitle,
    buildPhiFaviconSvg,
} from '../web/util.js';

const tab = (overrides = {}) => ({
    isDead: false,
    isBusy: false,
    isAttention: false,
    ...overrides,
});

describe('terminal activity browser-chrome grammar', () => {
    it('uses capital Phi while every live terminal is quiet', () => {
        const state = getTerminalActivityState([tab(), tab({ isBusy: true, isDead: true })]);
        expect(state).toEqual({ hasActivity: false, hasAttention: false });
        expect(phiActivityGlyph(state.hasActivity)).toBe('Φ');
        expect(formatTerminalActivityTitle('atlas', state)).toBe('Φ atlas');
    });

    it('uses curly Phi when any live terminal emitted output recently', () => {
        const state = getTerminalActivityState([tab(), tab({ isBusy: true })]);
        expect(state).toEqual({ hasActivity: true, hasAttention: false });
        expect(phiActivityGlyph(state.hasActivity)).toBe('ϕ');
        expect(formatTerminalActivityTitle('atlas', state)).toBe('ϕ atlas');
    });

    it('keeps the existing leading dot exclusively for attention/done', () => {
        const state = getTerminalActivityState([tab({ isAttention: true })]);
        expect(state).toEqual({ hasActivity: false, hasAttention: true });
        expect(formatTerminalActivityTitle('atlas', state)).toBe('● Φ atlas');
    });

    it('composes attention and output from different tabs without losing either', () => {
        const state = getTerminalActivityState([
            tab({ isAttention: true }),
            tab({ isBusy: true }),
        ]);
        expect(state).toEqual({ hasActivity: true, hasAttention: true });
        expect(formatTerminalActivityTitle('atlas', state)).toBe('● ϕ atlas');
    });

    it('keeps attention on a dead tab until the user clears it', () => {
        const state = getTerminalActivityState([tab({ isDead: true, isAttention: true, isBusy: true })]);
        expect(state).toEqual({ hasActivity: false, hasAttention: true });
        expect(formatTerminalActivityTitle('', state)).toBe('● Φ phi');
    });

    it('keeps the favicon in lockstep with the title glyph', () => {
        expect(buildPhiFaviconSvg('#abc', '#123', false)).toContain('>Φ</text>');
        expect(buildPhiFaviconSvg('#abc', '#123', true)).toContain('>ϕ</text>');
    });
});
