// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Mobile keyboard UX regression net.
//
// User report (2026-07-27): "edit models is broken and covered by software
// keyboard" on iOS WebKit. Architect audit found the same bug class
// affecting .config-editor-modal (Edit Model preset), .kanban-detail-panel
// (description textarea + Save in footer), and the access password prompt.
//
// jsdom doesn't apply stylesheets, so computed-style assertions are dead
// ends. We read web/style.css as text and assert the mobile block contains
// the right shape — same pattern as test-js/scrollBugs.test.js:212.
//
// Constraint: every fix must live inside @media (max-width: 768px) { ... }
// blocks. The negative-guard test at the bottom asserts the base
// .modal-overlay still says `height: 100vh` — proving no desktop pixel
// changed.

const CSS = readFileSync('web/style.css', 'utf8');

// Extract every @media (max-width: 768px) { ... } block. These are the
// mobile-only rules; we assert they contain the new shape and the base
// rules do not.
function extractMobileBlocks(css) {
    const blocks = [];
    const re = /@media\s*\(max-width:\s*768px\)\s*\{/g;
    let m;
    while ((m = re.exec(css)) !== null) {
        const start = m.index + m[0].length;
        let depth = 1;
        let i = start;
        while (i < css.length && depth > 0) {
            const ch = css[i];
            if (ch === '{') depth++;
            else if (ch === '}') depth--;
            i++;
        }
        blocks.push(css.slice(start, i - 1));
    }
    return blocks.join('\n');
}

const MOBILE = extractMobileBlocks(CSS);

// For the negative-guard: find the rule block whose selector exactly
// matches (not a longer selector like `.modal-overlay:not(.hidden)`).
// Phi organizes its CSS so many modal rules live INSIDE mobile
// @media blocks — the file isn't a clean "base then mobile overrides"
// structure. The test asserts the rule still has the expected desktop
// properties; it doesn't care which @media block contains it.
function extractRule(css, selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match selector at start-of-line (or after a newline) followed by
    // optional whitespace and `{`. Inside the braces, non-greedy match
    // since rules have no nested braces.
    const re = new RegExp('(?:^|\\n)' + escaped + '\\s*\\{[\\s\\S]*?\\}', 'm');
    const m = css.match(re);
    return m ? m[0] : '';
}

const DESKTOP_MODAL_OVERLAY = extractRule(CSS, '.modal-overlay');

describe('mobile keyboard — modal shapes use --vv-height, not 80vh', () => {
    it('mobile .modal-content, .md-modal-content uses var(--vv-height, 100dvh) for max-height', () => {
        // The user-reported regression: max-height was 80vh, which on iOS
        // equals 80% of the full document height including the keyboard
        // area. The modal would extend under the keyboard, hiding the
        // Save button. The fix replaces 80vh with var(--vv-height, 100dvh).
        const rule = MOBILE.match(/\.modal-content,\s*\.md-modal-content\s*\{[\s\S]*?\n\s*\}/);
        expect(rule, 'mobile .modal-content rule block not found').toBeTruthy();
        // Strip CSS comments before checking (the rule has an explanatory
        // comment that mentions "overflow-y: auto" — must not match itself).
        const ruleNoComments = rule[0].replace(/\/\*[\s\S]*?\*\//g, '');
        expect(ruleNoComments).toMatch(/var\(--vv-height/);
        // Negative guard: 80vh must NOT appear in this rule.
        expect(ruleNoComments).not.toMatch(/80vh/);
        // Negative guard: overflow-y: auto must NOT be on modal-content
        // (body is the scroller; footer stays pinned).
        expect(ruleNoComments).not.toMatch(/overflow-y:\s*auto/);
    });

    it('mobile .modal-overlay, .md-modal-overlay uses var(--vv-height) for height', () => {
        // The base overlay uses height: 100vh which on iOS = full window
        // including under the keyboard. Mobile override pins to --vv-height
        // so the overlay doesn't extend under the keyboard.
        const rule = MOBILE.match(/\.modal-overlay,\s*\.md-modal-overlay\s*\{[\s\S]*?\n\s*\}/);
        expect(rule, 'mobile .modal-overlay rule block not found').toBeTruthy();
        expect(rule[0]).toMatch(/var\(--vv-height/);
    });

    it('mobile .modal-body is the scroller; .modal-footer is pinned (flex-shrink: 0)', () => {
        // The "Save button under keyboard" bug had two causes: (a) the
        // modal-content itself was the scroller, and (b) the footer lived
        // inside that scroller. Fix: body is the scroller, footer is
        // flex-shrink: 0 (pinned to the visible bottom of the modal).
        const bodyRule = MOBILE.match(/\.modal-body,\s*\.md-modal-body\s*\{[\s\S]*?\n\s*\}/);
        expect(bodyRule, 'mobile .modal-body rule block not found').toBeTruthy();
        expect(bodyRule[0]).toMatch(/flex:\s*1 1 auto/);
        expect(bodyRule[0]).toMatch(/overflow-y:\s*auto/);
        const footerRule = MOBILE.match(/\.modal-footer\s*\{[\s\S]*?\n\s*\}/);
        expect(footerRule, 'mobile .modal-footer rule block not found').toBeTruthy();
        expect(footerRule[0]).toMatch(/flex-shrink:\s*0/);
    });

    it('mobile .config-editor-modal uses var(--vv-height) for max-height (Edit Model modal)', () => {
        // The specific user-reported case. Without this rule, the config
        // editor grows past the visible viewport on iOS, hiding the
        // "Save Model" button under the keyboard.
        const rule = MOBILE.match(/\.config-editor-modal\s*\{[\s\S]*?\n\s*\}/);
        expect(rule, 'mobile .config-editor-modal rule block not found').toBeTruthy();
        expect(rule[0]).toMatch(/var\(--vv-height/);
    });

    it('mobile .kanban-detail-panel uses var(--vv-height) for height (architect-caught gap)', () => {
        // The kanban detail panel has the same bug class as the config
        // editor: full-viewport panel, focus the textarea, Save button
        // (in .kdp-footer) sits behind the keyboard. Architect caught
        // this in review.
        const rule = MOBILE.match(/\.kanban-detail-panel\s*\{[\s\S]*?\n\s*\}/);
        expect(rule, 'mobile .kanban-detail-panel rule block not found').toBeTruthy();
        expect(rule[0]).toMatch(/var\(--vv-height/);
    });

    it('mobile .access-auth-overlay uses var(--vv-height) for height', () => {
        // The Sign-in-to-Phi prompt. inset: 0 at base covers the keyboard
        // on iOS, so the dialog (place-items: center) ends up sitting in
        // the keyboard area. vv-height re-centers the dialog within the
        // visible strip above the keyboard.
        const rule = MOBILE.match(/\.access-auth-overlay\s*\{[\s\S]*?\n\s*\}/);
        expect(rule, 'mobile .access-auth-overlay rule block not found').toBeTruthy();
        expect(rule[0]).toMatch(/var\(--vv-height/);
    });
});

describe('negative guard — desktop rules unchanged', () => {
    it('base .modal-overlay still uses height: 100vh (desktop untouched)', () => {
        // Constraint: "surgical fix that touches NONE of desktop".
        // If this test fails, the base rule was changed and the user
        // will see different desktop behavior.
        expect(DESKTOP_MODAL_OVERLAY).toBeTruthy();
        expect(DESKTOP_MODAL_OVERLAY).toMatch(/height:\s*100vh/);
        // Negative guard: the base must not gain the mobile-only
        // var(--vv-height) treatment. If someone duplicates the fix into
        // a base rule, this fails loudly.
        expect(DESKTOP_MODAL_OVERLAY).not.toMatch(/var\(--vv-height/);
    });

    it('base .access-auth-overlay still uses inset: 0 (desktop untouched)', () => {
        const m = extractRule(CSS, '.access-auth-overlay');
        expect(m, '.access-auth-overlay rule block not found').toBeTruthy();
        expect(m).toMatch(/inset:\s*0/);
        // Negative guard: no vv-height leak to base.
        expect(m).not.toMatch(/var\(--vv-height/);
    });

    it('base .config-editor-modal still has no max-height (desktop untouched)', () => {
        // Desktop config editor is sized by content; no height cap. The
        // mobile-only cap is what we add.
        const m = extractRule(CSS, '.config-editor-modal');
        expect(m, '.config-editor-modal rule block not found').toBeTruthy();
        expect(m).not.toMatch(/max-height/);
        // Negative guard: no vv-height leak to base.
        expect(m).not.toMatch(/var\(--vv-height/);
    });

    it('.kanban-detail-panel rule block has not been touched (base rule)', () => {
        // Phi puts the base .kanban-detail-panel rule at column 0 (top-level,
        // not inside a mobile @media). The mobile override we added lives
        // inside the existing @media block — that's a separate rule. This
        // test pins the base rule's shape; if a future refactor edits or
        // removes it, the test fails. The column-0 anchor in extractRule
        // is the implicit "base only" filter.
        const m = extractRule(CSS, '.kanban-detail-panel');
        expect(m, '.kanban-detail-panel rule block not found').toBeTruthy();
        // The existing rule has position: fixed + top: 0 + right: 0 + bottom: 0.
        // We assert these are still here (i.e., the rule itself wasn't deleted).
        expect(m).toMatch(/position:\s*fixed/);
        expect(m).toMatch(/top:\s*0/);
        expect(m).toMatch(/right:\s*0/);
        expect(m).toMatch(/bottom:\s*0/);
        // Negative guard: the base must not gain the mobile-only
        // var(--vv-height) treatment. If someone duplicates the fix into
        // a base rule, this fails loudly.
        expect(m).not.toMatch(/var\(--vv-height/);
    });
});
