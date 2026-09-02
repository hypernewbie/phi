// Guards the "zero animations at rest" contract for the always-on UI.
//
// This file previously asserted the opposite design: that every brand CPU tier
// carried `will-change: transform` to isolate it from the header's
// backdrop-filter. That was built on a wrong diagnosis. Ablation on the real
// shell measured the blur at ~8% of the cost and the animations at ~99%, and a
// single opacity animation on a blank page with no blur still cost ~2.4ms per
// frame. The charge is per frame for having any animation running at all.
//
// So the invariant worth protecting is not "promote the animations" but "do
// not run animations when nothing is happening" -- while keeping the static
// glow that carries the look. See temp/FASTMODE_PERF_JOURNAL.md.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(process.cwd(), 'web', 'style.css'), 'utf8');

// Strip comments first: a comment sitting above a rule otherwise gets absorbed
// into the first selector and breaks every matcher below.
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Body of the last rule whose selector list contains `selector`. */
function ruleBody(selector) {
    const bodies = [];
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m = re.exec(stripped);
    while (m !== null) {
        if (m[1].split(',').some((s) => s.trim() === selector))
            bodies.push(m[2]);
        m = re.exec(stripped);
    }
    return bodies.join('\n');
}

const ALWAYS_ON = [
    '.brand .logo.cpu-moderate',
    '.brand .logo.cpu-high',
    '.brand .logo.cpu-critical',
    '.brand .brand-name.cpu-moderate',
    '.brand .brand-name.cpu-high',
    '.brand .brand-name.cpu-critical',
    '.brand .terminal-activity-indicator.is-active',
    '.empty-logo',
];

describe('always-on UI runs no continuous animations', () => {
    for (const sel of ALWAYS_ON) {
        it(`${sel} has no infinite animation`, () => {
            const body = ruleBody(sel);
            expect(body, `${sel} should exist`).not.toBe('');
            expect(body).not.toMatch(/animation:[^;]*infinite/);
        });
    }

    it('the empty-state background and torchlight do not animate', () => {
        // These ran at 15s and 6s periods -- imperceptible, billed 60fps.
        expect(stripped).not.toMatch(/animation:[^;]*emptyBgPulse/);
        expect(stripped).not.toMatch(/animation:[^;]*torchflicker/);
        expect(stripped).not.toMatch(/animation:[^;]*logoBreathe/);
        expect(stripped).not.toMatch(/animation:[^;]*terminal-activity-cursor/);
    });
});

describe('the look is preserved statically', () => {
    // Removing the animations must not remove the glow with them. The tiers
    // had no static text-shadow at all -- it lived only inside the keyframes --
    // so a naive deletion would have silently flattened the brand.
    for (const sel of [
        '.brand .logo.cpu-moderate',
        '.brand .logo.cpu-high',
        '.brand .logo.cpu-critical',
    ]) {
        it(`${sel} keeps a static text-shadow`, () => {
            expect(ruleBody(sel)).toMatch(/text-shadow:/);
        });
    }

    it('cpu-high keeps its chromatic split', () => {
        const body = ruleBody('.brand .logo.cpu-high');
        expect(body).toMatch(/rgba\(0,\s*220,\s*255/);
        expect(body).toMatch(/rgba\(255,\s*0,\s*100/);
    });

    it('the empty logo keeps its glow', () => {
        const body = ruleBody('.empty-logo');
        expect(body).toMatch(/text-shadow:/);
        expect(body).toMatch(/drop-shadow/);
    });

    it('critical shows a standing ring instead of a repeating shockwave', () => {
        const body = ruleBody(
            '.brand:has(.cpu-critical) .logo-glow-wrapper::after',
        );
        expect(body).toMatch(/opacity:\s*0?\.\d/);
        expect(body).not.toMatch(/animation:[^;]*infinite/);
    });
});

describe('change is expressed by finite bursts', () => {
    it('the tier flourish runs a bounded number of iterations', () => {
        const body = ruleBody('.brand .logo.cpu-flourish');
        expect(body).toMatch(/animation:[^;]*cpu-tier-pop/);
        expect(body).not.toMatch(/infinite/);
    });

    it('the critical flourish shiver is bounded', () => {
        const body = ruleBody('.brand .logo.cpu-critical.cpu-flourish');
        expect(body).toMatch(/logo-shiver-hard/);
        expect(body).not.toMatch(/infinite/);
    });

    it('attention and stale states hold statically, not by animating', () => {
        // These persist until a human acts -- an unacknowledged tab could have
        // pulsed all night. Static colour carries the state; the burst is
        // bounded so the page returns to zero.
        for (const sel of ['.tab.has-attention', '.fleet-stale-badge']) {
            const body = ruleBody(sel);
            expect(body, `${sel} should exist`).not.toBe('');
            expect(body).not.toMatch(/animation:[^;]*infinite/);
        }
    });

    it('the activity wake plays once when is-active is applied', () => {
        const body = ruleBody('.brand .terminal-activity-indicator.is-active');
        expect(body).toMatch(/terminal-activity-wake/);
        // Trailing "1" is the iteration count; anything else would loop.
        expect(body).toMatch(/terminal-activity-wake[^;]*\s1\s*;/);
    });
});

describe('compositor promotion is scoped to what actually animates', () => {
    it('does not permanently promote the static tiers', () => {
        for (const sel of [
            '.brand .logo.cpu-moderate',
            '.brand .logo.cpu-critical',
            '.brand .terminal-activity-indicator.is-active',
        ]) {
            // Specifically `will-change: transform`. The fast-mode and
            // reduced-motion blocks also name these selectors, but to set
            // `will-change: auto`, which releases a layer rather than
            // creating one -- matching bare /will-change/ would flag those.
            expect(ruleBody(sel)).not.toMatch(/will-change:\s*transform/);
        }
    });

    it('promotes the flourish, which does animate transform', () => {
        expect(ruleBody('.brand .logo.cpu-flourish')).toBeDefined();
        expect(stripped).toMatch(
            /\.brand \.logo\.cpu-flourish[\s\S]{0,200}will-change:\s*transform/,
        );
    });
});
