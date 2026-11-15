import { describe, it, expect } from 'vitest';
import { computeKeyboardShift } from '../web/util.js';

// The software keyboard on iOS shrinks visualViewport.height while the layout
// viewport keeps its pre-keyboard size. The keyboard path must not resize any
// fit-observable box, so the root height is captured before the occlusion and
// the terminal content is translated by the overlap. These cases pin the
// detection boundaries that decide when a capture is taken, kept or dropped.

const EMPTY = {
    active: false,
    rootHeight: 0,
    visibleHeight: 0,
    layoutHeight: 0,
    layoutWidth: 0,
    shift: 0,
};

/** A closed, settled viewport sample. */
const closed = (height, width = 390) => ({
    ...EMPTY,
    visibleHeight: height,
    layoutHeight: height,
    layoutWidth: width,
});

const sample = (state, visibleHeight, layoutHeight, layoutWidth) =>
    computeKeyboardShift(state, visibleHeight, layoutHeight, layoutWidth);

describe('computeKeyboardShift', () => {
    it('U1 seeds a baseline without detecting an occlusion', () => {
        const next = sample(EMPTY, 844, 844, 390);
        expect(next.active).toBe(false);
        expect(next.shift).toBe(0);
        expect(next.rootHeight).toBe(0);
        expect(next.visibleHeight).toBe(844);
        expect(next.layoutHeight).toBe(844);
        expect(next.layoutWidth).toBe(390);
    });

    it('U2 detects a visible-only drop and captures the pre-drop height', () => {
        const next = sample(closed(844), 500, 844, 390);
        expect(next.active).toBe(true);
        expect(next.rootHeight).toBe(844);
        expect(next.shift).toBe(344);
        expect(next.visibleHeight).toBe(500);
    });

    it('U3 treats a drop of both heights as a layout resize, not a keyboard', () => {
        const next = sample(closed(844), 700, 700, 390);
        expect(next.active).toBe(false);
        expect(next.shift).toBe(0);
        expect(next.rootHeight).toBe(0);
        expect(next.visibleHeight).toBe(700);
        expect(next.layoutHeight).toBe(700);
    });

    it('U4 allows layout growth on the drop but never rewrites the capture', () => {
        const opened = sample(closed(844), 500, 900, 390);
        expect(opened.active).toBe(true);
        expect(opened.rootHeight).toBe(844);
        expect(opened.shift).toBe(344);

        // iOS may hide chrome while its keyboard animates. That growth is
        // not permission to resize the root.
        const grown = sample(opened, 450, 940, 390);
        expect(grown.active).toBe(true);
        expect(grown.rootHeight).toBe(844);
        expect(grown.shift).toBe(394);
        expect(grown.layoutHeight).toBe(940);
    });

    it('U5 keeps one captured root while the shift grows in steps', () => {
        const first = sample(closed(844), 600, 844, 390);
        expect(first.rootHeight).toBe(844);
        expect(first.shift).toBe(244);
        const second = sample(first, 500, 844, 390);
        expect(second.rootHeight).toBe(844);
        expect(second.shift).toBe(344);
        const third = sample(second, 420.5, 844, 390);
        expect(third.rootHeight).toBe(844);
        expect(third.shift).toBe(423.5);
        expect(third.shift).toBeGreaterThanOrEqual(0);
    });

    it('U6 clears when the visible height returns to the captured root', () => {
        const opened = sample(closed(844), 500, 844, 390);
        const restored = sample(opened, 844, 844, 390);
        expect(restored.active).toBe(false);
        expect(restored.shift).toBe(0);
        expect(restored.rootHeight).toBe(0);
        expect(restored.visibleHeight).toBe(844);
    });

    it('U7 never reports a negative shift on partial returns', () => {
        const opened = sample(closed(844), 500, 844, 390);
        const partial = sample(opened, 780, 844, 390);
        expect(partial.active).toBe(true);
        expect(partial.shift).toBe(64);
        expect(partial.shift).toBeGreaterThanOrEqual(0);
        const partialTwice = sample(partial, 843.5, 844, 390);
        expect(partialTwice.active).toBe(true);
        expect(partialTwice.shift).toBe(0.5);
        expect(partialTwice.shift).toBeGreaterThanOrEqual(0);
    });

    it('U8 rejects invalid dimensions and only seeds afterwards', () => {
        const opened = sample(closed(844), 500, 844, 390);
        expect(opened.active).toBe(true);

        const invalidValues = [
            0,
            -1,
            Number.NaN,
            Number.POSITIVE_INFINITY,
            -Infinity,
        ];
        for (const bad of invalidValues) {
            // Violates exactly one dimension at a time.
            const badVisible = sample(opened, bad, 844, 390);
            const badLayout = sample(opened, 500, bad, 390);
            const badWidth = sample(opened, 500, 844, bad);
            for (const next of [badVisible, badLayout, badWidth]) {
                expect(next).toEqual(EMPTY);
            }
        }

        // The next valid sample only seeds; it cannot detect on its own.
        const seeded = sample(EMPTY, 844, 844, 390);
        expect(seeded.active).toBe(false);
        expect(seeded.shift).toBe(0);

        // A later drop still detects normally.
        const detected = sample(seeded, 500, 844, 390);
        expect(detected.active).toBe(true);
        expect(detected.rootHeight).toBe(844);
        expect(detected.shift).toBe(344);
    });

    it('U9 preserves fractional heights exactly and mutates no input', () => {
        const previous = closed(844);
        const frozen = { ...previous };
        const opened = sample(previous, 500.25, 844, 390);
        expect(previous).toEqual(frozen);
        expect(opened.rootHeight).toBe(844);
        expect(opened.shift).toBe(343.75);

        const animated = sample(opened, 620.375, 844, 390);
        expect(animated.rootHeight).toBe(844);
        expect(animated.shift).toBe(223.625);

        // A repeated sample must be a no-op for the state, so a browser that
        // fires resize and scroll for one keyboard step cannot drift.
        const repeated = sample(animated, 620.375, 844, 390);
        expect(repeated).toEqual(animated);
        expect(animated).toEqual({
            ...EMPTY,
            active: true,
            rootHeight: 844,
            visibleHeight: 620.375,
            layoutHeight: 844,
            layoutWidth: 390,
            shift: 223.625,
        });

        const restored = sample(animated, 844, 844, 390);
        expect(restored.active).toBe(false);
        expect(restored.shift).toBe(0);
    });

    it('U10 resets on a layout width change and only reacts to a later drop', () => {
        const opened = sample(closed(844), 500, 844, 390);
        expect(opened.active).toBe(true);

        const rotated = sample(opened, 400, 844, 430);
        expect(rotated.active).toBe(false);
        expect(rotated.shift).toBe(0);
        expect(rotated.visibleHeight).toBe(400);
        expect(rotated.layoutWidth).toBe(430);

        const dropped = sample(rotated, 300, 844, 430);
        expect(dropped.active).toBe(true);
        expect(dropped.rootHeight).toBe(400);
        expect(dropped.shift).toBe(100);
    });

    it('U11 a real layout shrink clears and re-captures the new baseline', () => {
        const opened = sample(closed(844), 500, 844, 390);
        expect(opened.rootHeight).toBe(844);

        const shrunk = sample(opened, 500, 780, 390);
        expect(shrunk.active).toBe(false);
        expect(shrunk.shift).toBe(0);
        expect(shrunk.layoutHeight).toBe(780);

        // The visible height catches up with the new, smaller layout.
        const rested = sample(shrunk, 780, 780, 390);
        expect(rested.active).toBe(false);
        expect(rested.shift).toBe(0);

        const reopened = sample(rested, 500, 780, 390);
        expect(reopened.active).toBe(true);
        expect(reopened.rootHeight).toBe(780);
        expect(reopened.shift).toBe(280);
    });

    it('U12 a partial return keeps the pin and the next cycle re-captures', () => {
        const opened = sample(closed(844), 500, 844, 390);
        const partial = sample(opened, 780, 844, 390);
        expect(partial.active).toBe(true);
        expect(partial.rootHeight).toBe(844);
        expect(partial.shift).toBe(64);

        const restored = sample(partial, 844, 844, 390);
        expect(restored.active).toBe(false);
        expect(restored.shift).toBe(0);

        // A second cycle captures its own preceding height, not a historical
        // maximum: after a real layout change the resting height is 780.
        const smaller = sample(closed(780), 500, 780, 390);
        expect(smaller.active).toBe(true);
        expect(smaller.rootHeight).toBe(780);
        expect(smaller.shift).toBe(280);

        const closedAgain = sample(smaller, 780, 780, 390);
        expect(closedAgain.active).toBe(false);
        expect(closedAgain.rootHeight).toBe(0);
    });
});
