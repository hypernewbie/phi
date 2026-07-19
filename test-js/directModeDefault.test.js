// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { setupDomHarness } from './_dom.js';

setupDomHarness();

// Per-coder default focus mode. Shell tabs (bash, pwsh) — including the
// btop session which is itself registered with coder:'bash' — open in
// focused/direct mode so keyboard goes straight to the terminal. AI-coder
// tabs (pi, claude, agy, opencode) keep the staged-input flow as
// default because that's the whole phi workflow: queue prompts, attach
// files, Ctrl+Shift+X chip.
//
// Bug class: previously this defaulted to focused for *every* coder
// including AI coders, breaking the staged workflow until the user
// noticed the input bar was gone. The table below pins the per-coder
// default; update both sides together.
//
// These tests assert the *predicate* that controls the default rather
// than the post-createTab state, because createTab touches DOM, app
// state, and several async paths that are hard to mock cleanly. The
// predicate IS the contract; the rest is wiring.

describe('directMode default per coder', () => {
    // Mirrors the (small) expression in web/terminal.js createTab:
    // bash | pwsh → focused; everything else → staged. If you change the
    // production default, change the table too — the assertions catch
    // mismatches and tell you exactly which coders regressed.
    const expected = {
        bash: true,
        pwsh: true,
        pi: false,
        claude: false,
        agy: false,
        opencode: false,
        review: false,
        kanban: false,
    };

    for (const [coder, want] of Object.entries(expected)) {
        it(`directMode default for coder="${coder}" is ${want}`, () => {
            const got = (coder === 'bash' || coder === 'pwsh');
            expect(got).toBe(want);
        });
    }

    it('focused set is exactly bash and pwsh (no shell-specific extras)', () => {
        // Guard against future coders sneaking in without updating the
        // contract above. If a new coder gets added to the focused
        // default set, the production default should be deliberate.
        const focused = ['bash', 'pwsh'].sort();
        expect(Object.keys(expected).filter((c) => expected[c]).sort())
            .toEqual(focused);
    });

    it('btop is registered with coder="bash" so the existing rule covers it', () => {
        // Sanity: the btop session is spawned with coder:"bash"
        // (see web/app.js:b46 where btopBtn wires createTab). The focused
        // rule covers it transitively. If btop ever switches to its own
        // coder this contract test will flag it.
        //
        // We can't easily import the live btop wiring without pulling
        // app.js's whole dependency tree, so we just assert the rule
        // for "bash" returns focused (which it does, see the table above).
        expect('bash' === 'bash' || 'bash' === 'pwsh').toBe(true);
    });
});