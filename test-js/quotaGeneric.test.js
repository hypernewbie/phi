// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { renderQuotaInto } from '../web/quota.js';

setupDomHarness();

function render(data) {
    const body = document.createElement('div');
    renderQuotaInto(body, data);
    return body;
}

describe('snapshot v1 generic renderer', () => {
    it('renders unknown-to-client section ids without "unrecognized format"', () => {
        const body = render({
            version: 1,
            sections: [
                {
                    id: 'opencode_go_nomad',
                    rows: [
                        {
                            label: 'Weekly',
                            remaining_percent: 72,
                            resets_at: '2026-09-14T00:00:00Z',
                        },
                    ],
                },
            ],
        });
        expect(body.textContent).toContain('Opencode Go Nomad');
        expect(body.textContent).toContain('Weekly');
        expect(body.textContent).not.toContain('unrecognized format');
        expect(body.querySelector('.quota-fill').style.width).toBe('72%');
    });

    it('prefers an explicit title over the id fallback', () => {
        const body = render({
            version: 1,
            sections: [
                {
                    id: 'opencode_go_nomad',
                    title: 'opencode · nomad',
                    rows: [{ label: 'Weekly', remaining_percent: 50 }],
                },
            ],
        });
        expect(body.textContent).toContain('opencode · nomad');
        expect(body.textContent).not.toContain('Opencode Go Nomad');
    });

    it('renders every row kind with documented precedence', () => {
        const body = render({
            version: 1,
            sections: [
                {
                    title: 'kinds',
                    rows: [
                        { label: 'Left', remaining_percent: 63 },
                        // used wins over text; bar flips to remaining.
                        {
                            label: 'Burned',
                            used_percent: 71,
                            text: 'ignored',
                        },
                        {
                            label: 'Session',
                            used: 0.24,
                            total: 12.0,
                            unit: 'USD',
                        },
                        {
                            label: 'Tokens',
                            used: 30,
                            total: 100,
                            unit: 'tokens',
                        },
                        { label: 'Notice', text: 'all systems nominal' },
                    ],
                },
            ],
        });
        const fills = Array.from(body.querySelectorAll('.quota-fill')).map(
            (el) => el.style.width,
        );
        // 63 direct, 100-71 flipped, (1-0.24/12)*100 = 98, (1-30/100)*100 = 70.
        expect(fills).toEqual(['63%', '29%', '98%', '70%']);
        expect(body.textContent).toContain('$0.24 of $12.00');
        expect(body.textContent).toContain('30 tokens of 100 tokens');
        expect(body.textContent).toContain('all systems nominal');
    });

    it('accepts ISO, epoch seconds, and epoch millis reset times', () => {
        const body = render({
            version: 1,
            sections: [
                {
                    title: 'resets',
                    rows: [
                        {
                            label: 'Iso',
                            remaining_percent: 10,
                            resets_at: '2026-09-14T00:00:00Z',
                        },
                        {
                            label: 'Secs',
                            remaining_percent: 10,
                            resets_at: 1789293600,
                        },
                        {
                            label: 'Millis',
                            remaining_percent: 10,
                            resets_at: 1789293600000,
                        },
                        { label: 'None', remaining_percent: 10 },
                    ],
                },
            ],
        });
        const notes = Array.from(
            body.querySelectorAll('.quota-row .quota-note'),
        ).map((el) => el.textContent);
        // The row without resets_at renders no note element at all.
        expect(notes).toHaveLength(3);
        for (const note of notes) expect(note).toMatch(/resets /);
    });

    it('honours a per-row low_below threshold', () => {
        const body = render({
            version: 1,
            sections: [
                {
                    title: 'low',
                    rows: [
                        {
                            label: 'Custom',
                            remaining_percent: 20,
                            low_below: 25,
                        },
                        { label: 'Default', remaining_percent: 20 },
                    ],
                },
            ],
        });
        const lows = body.querySelectorAll('.quota-fill.is-low');
        expect(lows).toHaveLength(1);
    });

    it('skips bad rows and sections but keeps the rest', () => {
        const body = render({
            version: 1,
            sections: [
                {
                    title: 'mixed',
                    rows: [
                        { label: 'Good', remaining_percent: 41 },
                        { nope: 'no label' },
                        { label: '' },
                        { label: 'Empty envelope' },
                        42,
                        null,
                    ],
                },
                { title: 'all bad', rows: [{ nope: 1 }] },
                'not an object',
            ],
        });
        expect(body.textContent).toContain('Good');
        expect(body.textContent).toContain('41%');
        expect(body.textContent).not.toContain('all bad');
        expect(body.textContent).not.toContain('unrecognized format');
    });

    it('never throws on hostile JSON and reports empty snapshots', () => {
        expect(() => {
            render({ version: 1, sections: [] });
        }).not.toThrow();
        expect(render({ version: 1, sections: [] }).textContent).toContain(
            'No usable quota sections',
        );
        expect(render(null).textContent).toContain('Empty response');
        expect(render([1, { nested: [true] }]).textContent).toContain(
            'No usable quota sections',
        );
        // Legacy dict path still renders (deprecated shim).
        const legacy = render({
            quota: {
                model_remains: [
                    {
                        model_name: 'general',
                        current_interval_remaining_percent: 63,
                        current_weekly_remaining_percent: 54,
                        end_time: 1789293600000,
                        weekly_end_time: 1789344000000,
                    },
                ],
            },
        });
        expect(legacy.textContent).toContain('general');
    });

    it('escapes markup from untrusted snapshots', () => {
        const body = render({
            version: 1,
            sections: [
                {
                    title: '<img src=x>',
                    rows: [
                        {
                            label: '<b>Weekly</b>',
                            text: '<script>alert(1)</script>',
                        },
                    ],
                },
            ],
        });
        expect(body.querySelector('img')).toBeNull();
        expect(body.querySelector('script')).toBeNull();
        expect(body.textContent).toContain('<b>Weekly</b>');
    });
});
