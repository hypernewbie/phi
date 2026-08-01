// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// .brand is a direct child of .app-header, which carries
// `backdrop-filter: blur(20px) saturate(180%)`. Any repaint inside that
// subtree forces the blur to re-run for the whole header strip, every frame.
//
// Measured on one core: animations off 5.3%, breath+blink 100.5%, and the
// same two animations with their own compositor layer 30.3%. Notably a pure
// opacity blink cost 121.3% on its own -- as much as a text-shadow breath --
// which is the tell that the cost is the backdrop-filter recompute rather
// than the property being animated.
//
// These pin the promotion, because it is invisible: removing `will-change`
// changes nothing on screen and triples idle CPU.

// Comments must go first: a comment sitting directly above a rule would
// otherwise be absorbed into that rule's first selector by the matcher below,
// so only the first selector in a list would ever fail to match.
const css = readFileSync(join(process.cwd(), 'web', 'style.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');

// Extract a rule's declaration block by exact selector-list membership.
function blocksContainingSelector(selector) {
    const out = [];
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(css))) {
        const selectors = m[1].split(',').map((s) => s.trim());
        if (selectors.includes(selector)) out.push(m[2]);
    }
    return out;
}

const TIERS = ['moderate', 'high', 'critical'];

describe('brand CPU tiers are isolated from the header backdrop-filter', () => {
    it('the premise still holds: .app-header has a backdrop-filter', () => {
        // If this ever stops being true the promotion may be unnecessary --
        // but re-measure before removing it.
        const header = blocksContainingSelector('.app-header').join('\n');
        expect(header).toMatch(/backdrop-filter:\s*blur\(/);
    });

    it('the premise still holds: .brand is a child of .app-header', () => {
        const html = readFileSync(join(process.cwd(), 'web', 'index.html'), 'utf8');
        expect(html).toMatch(/<header class="app-header">\s*[\r\n]\s*<div class="brand">/);
    });

    it.each(TIERS)('promotes .logo.cpu-%s to its own layer', (tier) => {
        const blocks = blocksContainingSelector(`.brand .logo.cpu-${tier}`);
        expect(blocks.some((b) => /will-change:\s*transform/.test(b))).toBe(true);
    });

    it.each(TIERS)('promotes .brand-name.cpu-%s to its own layer', (tier) => {
        const blocks = blocksContainingSelector(`.brand .brand-name.cpu-${tier}`);
        expect(blocks.some((b) => /will-change:\s*transform/.test(b))).toBe(true);
    });

    it('does not set a base transform that the shiver would fight', () => {
        // cpu-high / cpu-critical animate transform. A `transform: translateZ(0)`
        // base would be overridden on every keyframe; will-change alone promotes.
        const blocks = [
            ...blocksContainingSelector('.brand .logo.cpu-high'),
            ...blocksContainingSelector('.brand .logo.cpu-critical'),
        ];
        for (const b of blocks) {
            if (/will-change/.test(b)) expect(b).not.toMatch(/^\s*transform:/m);
        }
    });

    it('releases the layer when the animation is disabled', () => {
        // A promoted layer with nothing animating is pure GPU-memory waste,
        // and fast mode exists to reclaim idle cost.
        expect(css).toMatch(/body\.fast-mode \.brand \.logo,\s*[\r\n]\s*body\.fast-mode \.brand \.brand-name \{[^}]*will-change:\s*auto/);
        // prefers-reduced-motion kills the same animations.
        const rm = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
        expect(rm).toMatch(/will-change:\s*auto/);
    });
});
