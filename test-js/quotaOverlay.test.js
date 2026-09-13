// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import {
    getQuotaUrl,
    setQuotaUrl,
    renderQuotaInto,
    openQuotaOverlay,
    initQuotaButton,
    QUOTA_URL_KEY,
    DEFAULT_QUOTA_URL,
} from '../web/quota.js';

setupDomHarness();

// Trimmed live payload from http://charon/api/all — one row per shape.
const FIXTURE = {
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
        base_resp: { status_code: 0, status_msg: 'success' },
    },
    deepseek: {
        is_available: true,
        balance_infos: [
            {
                currency: 'USD',
                total_balance: '12.97',
                granted_balance: '0.00',
                topped_up_balance: '12.97',
            },
        ],
    },
    glm: {
        code: 200,
        data: {
            level: 'lite',
            limits: [
                {
                    type: 'TOKENS_LIMIT',
                    percentage: 71,
                    nextResetTime: 1789284086709,
                },
            ],
        },
        success: true,
    },
    openrouter: { data: { total_credits: 70, total_usage: 59.3 } },
    codex: {
        status: 'ok',
        lines: [
            'Account: someone@example.com (Pro Lite)',
            'Weekly limit: [███░░] 46% left (resets 01:09 on 19 Sep)',
        ],
        syncing: false,
    },
    agy: {
        status: 'ok',
        groups: [
            {
                name: 'Gemini Models',
                models: ['Gemini Flash'],
                limits: [
                    {
                        name: 'Weekly Limit Remaining',
                        percent: 71.97,
                        remaining_text: '72% remaining',
                        disabled: false,
                    },
                ],
            },
        ],
        syncing: false,
    },
    opencode_go: {
        session: { spent: 0.24, limit: 12, resetsAt: '2026-09-13T07:13:07Z' },
        weekly: { spent: 0.3, limit: 30, resetsAt: '2026-09-14T00:00:00Z' },
        hasData: true,
    },
};

beforeEach(() => {
    localStorage.clear();
});

describe('quota source URL', () => {
    it('defaults to the charon aggregator', () => {
        expect(getQuotaUrl()).toBe(DEFAULT_QUOTA_URL);
        expect(DEFAULT_QUOTA_URL).toBe('http://charon/api/all');
    });

    it('persists a valid URL and rejects the rest', () => {
        expect(setQuotaUrl('http://charon/api/all')).toContain('charon');
        expect(localStorage.getItem(QUOTA_URL_KEY)).toContain('charon');
        expect(() => setQuotaUrl('not a url')).toThrow();
        expect(() => setQuotaUrl('ftp://x/y')).toThrow();
        expect(() => setQuotaUrl('')).toThrow();
    });
});

describe('renderQuotaInto', () => {
    it('renders one section per known provider', () => {
        const body = document.createElement('div');
        renderQuotaInto(body, FIXTURE);
        const text = body.textContent;
        for (const name of [
            'general',
            'DeepSeek',
            '$12.97',
            'GLM',
            'OpenRouter',
            'Codex',
            'Antigravity',
            'opencode',
        ]) {
            expect(text).toContain(name);
        }
        // Percent bars carry real widths.
        const fills = Array.from(body.querySelectorAll('.quota-fill')).map(
            (el) => el.style.width,
        );
        expect(fills).toContain('63%');
        expect(fills).toContain('71%');
        // Codex pre-rendered lines survive verbatim.
        expect(body.querySelector('.quota-pre').textContent).toContain(
            '46% left',
        );
    });

    it('renders unknown providers as raw-JSON details instead of dropping them', () => {
        const body = document.createElement('div');
        renderQuotaInto(body, {
            ...FIXTURE,
            future_provider: { some: ['new', 'shape', 42] },
        });
        const details = body.querySelector('details.quota-raw');
        expect(details).toBeTruthy();
        expect(details.querySelector('summary').textContent).toContain(
            'future_provider',
        );
        expect(details.querySelector('pre').textContent).toContain('"some"');
    });

    it('isolates a broken section instead of blanking the overlay', () => {
        const body = document.createElement('div');
        const evil = {
            get model_remains() {
                throw new Error('boom');
            },
        };
        renderQuotaInto(body, { ...FIXTURE, quota: evil });
        expect(body.textContent).toContain('Could not parse this section');
        // Healthy providers still render.
        expect(body.textContent).toContain('DeepSeek');
    });

    it('marks nearly-exhausted bars low', () => {
        const body = document.createElement('div');
        renderQuotaInto(body, {
            agy: {
                status: 'ok',
                groups: [
                    {
                        name: 'G',
                        models: [],
                        limits: [
                            {
                                name: 'Five Hour',
                                percent: 0.54,
                                remaining_text: '1%',
                                disabled: false,
                            },
                        ],
                    },
                ],
            },
        });
        const low = body.querySelector('.quota-fill.is-low');
        expect(low).toBeTruthy();
        expect(low.style.width).toBe('0.54%');
    });
});

describe('openQuotaOverlay', () => {
    it('opens from the footer quota button and fetches the saved URL', async () => {
        document.body.innerHTML = '<button id="phi-quota-btn">◔</button>';
        const fetchSpy = mockFetch((url) => {
            expect(String(url)).toBe(DEFAULT_QUOTA_URL);
            return FIXTURE;
        });
        initQuotaButton();
        document.getElementById('phi-quota-btn').click();
        await vi.waitFor(() => {
            expect(document.querySelector('.quota-overlay')).toBeTruthy();
        });
        await vi.waitFor(() => {
            expect(
                document.querySelector('.quota-body .quota-section'),
            ).toBeTruthy();
        });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(document.querySelector('#quota-source-url').value).toBe(
            DEFAULT_QUOTA_URL,
        );
    });

    it('saving a new URL persists it and refetches', async () => {
        mockFetch((url) => FIXTURE);
        openQuotaOverlay();
        await vi.waitFor(() => {
            expect(
                document.querySelector('.quota-body .quota-section'),
            ).toBeTruthy();
        });
        const input = document.querySelector('#quota-source-url');
        input.value = 'http://other-host:8080/q';
        document.querySelector('[data-quota-save]').click();
        await vi.waitFor(() => {
            expect(
                document.querySelector('[data-quota-saved]').textContent,
            ).toBe('Saved');
        });
        expect(localStorage.getItem(QUOTA_URL_KEY)).toBe(
            'http://other-host:8080/q',
        );
    });

    it('shows an error with retry when the source is unreachable', async () => {
        let fail = true;
        mockFetch(() => {
            if (fail) throw new Error('network down');
            return FIXTURE;
        });
        openQuotaOverlay();
        await vi.waitFor(() => {
            expect(document.querySelector('.quota-error')).toBeTruthy();
        });
        fail = false;
        document.querySelector('[data-quota-retry]').click();
        await vi.waitFor(() => {
            expect(
                document.querySelector('.quota-body .quota-section'),
            ).toBeTruthy();
        });
    });

    it('closes on Escape and outside click', async () => {
        mockFetch(() => FIXTURE);
        openQuotaOverlay();
        await vi.waitFor(() => {
            expect(document.querySelector('.quota-overlay')).toBeTruthy();
        });
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(document.querySelector('.quota-overlay')).toBeNull();

        openQuotaOverlay();
        await vi.waitFor(() => {
            expect(document.querySelector('.quota-overlay')).toBeTruthy();
        });
        document
            .querySelector('.quota-overlay')
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(document.querySelector('.quota-overlay')).toBeNull();
    });
});
