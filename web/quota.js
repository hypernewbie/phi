// Model-quota overlay for Phi. Fetches a JSON quota snapshot from a
// user-configured URL (default http://charon/api/all) and renders one
// section per provider. Every renderer is defensive: missing shapes skip
// their section, a throwing renderer becomes a section-level error, and
// unrecognized top-level keys fall back to a raw-JSON details block so
// new providers keep working without a client change.
//
// The overlay reuses the standard modal classes (.modal-overlay,
// .modal-content, .modal-header/body/footer), so all existing compact
// behavior (keyboard-aware heights, pinned footer) applies untouched.
import { escapeHtml } from './util.js';

export const QUOTA_URL_KEY = 'phi_quota_url';
export const DEFAULT_QUOTA_URL = 'http://charon/api/all';

export function getQuotaUrl() {
    try {
        return localStorage.getItem(QUOTA_URL_KEY) || DEFAULT_QUOTA_URL;
    } catch {
        return DEFAULT_QUOTA_URL;
    }
}

export function setQuotaUrl(raw) {
    const url = String(raw || '').trim();
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error('Enter a valid http(s) quota URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Enter a valid http(s) quota URL');
    }
    try {
        localStorage.setItem(QUOTA_URL_KEY, parsed.toString());
    } catch {
        // Storage blocked (private mode): the overlay still works for
        // this session, it just will not remember the URL.
    }
    return parsed.toString();
}

async function fetchQuota(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Quota source returned HTTP ${res.status}`);
    return res.json();
}

function pctNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
}

function bar(percent) {
    const pct = pctNumber(percent);
    if (pct === null) return '<span class="quota-val">—</span>';
    const low = pct < 10 ? ' is-low' : '';
    return (
        `<div class="quota-bar" role="img" aria-label="${pct}% remaining">` +
        `<div class="quota-fill${low}" style="width:${pct}%"></div></div>` +
        `<span class="quota-val">${pct}%</span>`
    );
}

function fmtClock(ms) {
    const t = Number(ms);
    if (!Number.isFinite(t) || t <= 0) return '—';
    try {
        return new Date(t).toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    } catch {
        return '—';
    }
}

function fmtStamp(value) {
    // Epoch seconds (codex/opencode timestamps) vs epoch millis.
    const t = Number(value);
    if (!Number.isFinite(t) || t <= 0) return '—';
    return fmtClock(t < 1e12 ? t * 1000 : t);
}

function fmtDur(ms) {
    const t = Number(ms);
    if (!Number.isFinite(t) || t < 0) return '—';
    const s = Math.floor(t / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    return `${s}s`;
}

function section(title, inner) {
    return (
        `<section class="quota-section"><h4>${escapeHtml(title)}</h4>` +
        `${inner}</section>`
    );
}

function row(label, barHtml, note) {
    return (
        `<div class="quota-row"><span class="quota-label">${escapeHtml(label)}</span>` +
        `${barHtml}` +
        (note ? `<span class="quota-note">${escapeHtml(note)}</span>` : '') +
        `</div>`
    );
}

function money(n) {
    const v = Number(n);
    return Number.isFinite(v) ? `$${v.toFixed(2)}` : '—';
}

const RENDERERS = {
    quota(q) {
        const remains = Array.isArray(q?.model_remains) ? q.model_remains : [];
        if (remains.length === 0) return '';
        return remains
            .map((m) =>
                section(
                    `Minimax · ${m?.model_name ?? 'model'}`,
                    row(
                        'Interval',
                        bar(m?.current_interval_remaining_percent),
                        `resets ${fmtClock(m?.end_time)}`,
                    ) +
                        row(
                            'Weekly',
                            bar(m?.current_weekly_remaining_percent),
                            `resets ${fmtClock(m?.weekly_end_time)}`,
                        ),
                ),
            )
            .join('');
    },
    deepseek(d) {
        if (!Array.isArray(d?.balance_infos) || d.balance_infos.length === 0) {
            return '';
        }
        const lines = d.balance_infos
            .map(
                (b) =>
                    `<div class="quota-line"><span>${money(b?.total_balance)} ` +
                    `${escapeHtml(b?.currency ?? '')}</span>` +
                    `<span class="quota-note">topped up ${money(b?.topped_up_balance)}</span></div>`,
            )
            .join('');
        const avail =
            d?.is_available === false
                ? '<div class="quota-warn">reported unavailable</div>'
                : '';
        return section('DeepSeek', avail + lines);
    },
    glm(g) {
        const limits = Array.isArray(g?.data?.limits) ? g.data.limits : [];
        if (g?.code !== 200 && limits.length === 0) return '';
        const level = g?.data?.level
            ? `<div class="quota-line"><span>Plan</span><span class="quota-note">${escapeHtml(g.data.level)}</span></div>`
            : '';
        return section(
            'GLM',
            level +
                limits
                    .map((l) =>
                        row(
                            String(l?.type ?? 'limit').replace(/_/g, ' '),
                            bar(l?.percentage),
                            `resets ${fmtClock(l?.nextResetTime)}`,
                        ),
                    )
                    .join(''),
        );
    },
    openrouter(o) {
        const credits = Number(o?.data?.total_credits);
        const used = Number(o?.data?.total_usage);
        if (!Number.isFinite(credits) || !Number.isFinite(used)) return '';
        const left = Math.max(0, credits - used);
        const pct = credits > 0 ? (left / credits) * 100 : 0;
        return section(
            'OpenRouter',
            `<div class="quota-line"><span>${money(left)} left</span>` +
                `<span class="quota-note">${money(used)} of ${money(credits)} used</span></div>` +
                row('Credits', bar(pct), ''),
        );
    },
    codex(c) {
        if (c?.status !== 'ok' || !Array.isArray(c?.lines)) return '';
        const account = (
            c.lines.find((l) => String(l).startsWith('Account:')) || ''
        ).replace(/^Account:\s*/, '');
        return section(
            'Codex' + (account ? ` · ${account}` : ''),
            `<pre class="quota-pre">${escapeHtml(c.lines.join('\n'))}</pre>` +
                (c.syncing ? '<div class="quota-note">syncing…</div>' : ''),
        );
    },
    agy(a) {
        const groups = Array.isArray(a?.groups) ? a.groups : [];
        if (a?.status !== 'ok' && groups.length === 0) return '';
        return groups
            .map((g) =>
                section(
                    `Antigravity · ${g?.name ?? 'group'}`,
                    `<div class="quota-note">${escapeHtml((g?.models ?? []).join(' · '))}</div>` +
                        (Array.isArray(g?.limits) ? g.limits : [])
                            .map(
                                (l) =>
                                    `<div class="quota-row${l?.disabled ? ' is-disabled' : ''}">` +
                                    `<span class="quota-label">${escapeHtml(l?.name ?? 'limit')}</span>` +
                                    `${bar(l?.percent)}` +
                                    `<span class="quota-note">${escapeHtml(l?.remaining_text ?? '')}</span></div>`,
                            )
                            .join(''),
                ),
            )
            .join('');
    },
    opencode_go(o) {
        const buckets = ['session', 'weekly', 'monthly'].filter(
            (k) => o?.[k] && Number.isFinite(Number(o[k].limit)),
        );
        if (buckets.length === 0 && !o?.hasData) return '';
        return section(
            'opencode',
            buckets
                .map((k) => {
                    const b = o[k];
                    const limit = Number(b.limit);
                    const spent = Number(b.spent) || 0;
                    const pct =
                        limit > 0
                            ? Math.max(0, (1 - spent / limit) * 100)
                            : 100;
                    const name = k[0].toUpperCase() + k.slice(1);
                    return row(
                        name,
                        bar(pct),
                        `${money(spent)} of ${money(limit)} · resets ${fmtStamp(b.resetsAt)}`,
                    );
                })
                .join(''),
        );
    },
};

function renderUnknown(key, value) {
    return (
        `<details class="quota-raw"><summary>${escapeHtml(key)} (unrecognized format)</summary>` +
        `<pre class="quota-pre">${escapeHtml(JSON.stringify(value, null, 2) ?? '')}</pre></details>`
    );
}

// Renders every top-level provider of a quota snapshot into bodyEl.
// Pure DOM output — exported for tests.
export function renderQuotaInto(bodyEl, data) {
    if (!data || typeof data !== 'object') {
        bodyEl.innerHTML =
            '<div class="quota-error">Empty response from the quota source.</div>';
        return;
    }
    const parts = [];
    for (const key of Object.keys(data)) {
        const render = RENDERERS[key];
        if (!render) {
            parts.push(renderUnknown(key, data[key]));
            continue;
        }
        try {
            const html = render(data[key]);
            if (html) parts.push(html);
        } catch {
            parts.push(
                section(
                    key,
                    '<div class="quota-error">Could not parse this section.</div>',
                ),
            );
        }
    }
    bodyEl.innerHTML =
        parts.length > 0
            ? parts.join('')
            : '<div class="quota-error">No usable quota sections in the response.</div>';
}

async function loadInto(bodyEl, footerEl, url) {
    bodyEl.innerHTML = '<div class="md-list-loading">Loading quota...</div>';
    try {
        const data = await fetchQuota(url);
        renderQuotaInto(bodyEl, data);
        if (footerEl) {
            footerEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
        }
    } catch (err) {
        const message =
            err instanceof Error ? err.message : 'Quota fetch failed';
        bodyEl.innerHTML =
            `<div class="quota-error">${escapeHtml(message)}</div>` +
            '<div class="quota-retry"><button type="button" class="btn" data-quota-retry>Retry</button></div>';
        const retry = bodyEl.querySelector('[data-quota-retry]');
        if (retry) {
            retry.addEventListener('click', () =>
                loadInto(bodyEl, footerEl, url),
            );
        }
    }
}

export function openQuotaOverlay() {
    document.querySelector('.quota-overlay')?.remove();
    const current = getQuotaUrl();

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay quota-overlay hidden';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Model quota');
    overlay.innerHTML =
        '<div class="modal-content quota-modal">' +
        '<div class="modal-header"><h3>Model quota</h3>' +
        '<button type="button" class="modal-close-btn" data-quota-close aria-label="Close">×</button></div>' +
        '<div class="quota-source"><label for="quota-source-url">Quota source</label>' +
        `<input id="quota-source-url" type="url" spellcheck="false" value="${escapeHtml(current)}">` +
        '<button type="button" class="btn" data-quota-save>Save</button>' +
        '<span class="quota-saved" data-quota-saved></span></div>' +
        '<div class="modal-body quota-body"></div>' +
        '<div class="modal-footer"><span class="quota-updated" data-quota-updated></span>' +
        '<button type="button" class="btn" data-quota-refresh>Refresh</button></div>' +
        '</div>';

    const bodyEl = overlay.querySelector('.quota-body');
    const updatedEl = overlay.querySelector('[data-quota-updated]');
    const urlInput = overlay.querySelector('#quota-source-url');
    const savedEl = overlay.querySelector('[data-quota-saved]');

    const close = () => {
        document.removeEventListener('keydown', onKeydown);
        overlay.remove();
    };
    const onKeydown = (e) => {
        if (e.key === 'Escape') close();
    };
    overlay
        .querySelector('[data-quota-close]')
        .addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
    });
    document.addEventListener('keydown', onKeydown);

    overlay
        .querySelector('[data-quota-refresh]')
        .addEventListener('click', () => {
            void loadInto(bodyEl, updatedEl, urlInput.value.trim() || current);
        });
    overlay.querySelector('[data-quota-save]').addEventListener('click', () => {
        savedEl.textContent = '';
        try {
            const saved = setQuotaUrl(urlInput.value);
            urlInput.value = saved;
            savedEl.textContent = 'Saved';
            void loadInto(bodyEl, updatedEl, saved);
        } catch (err) {
            savedEl.textContent =
                err instanceof Error ? err.message : 'Invalid URL';
        }
    });

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.remove('hidden'));
    void loadInto(bodyEl, updatedEl, current);
    return overlay;
}

export function initQuotaButton() {
    const btn = document.getElementById('phi-quota-btn');
    if (!btn || btn.dataset.quotaWired === '1') return;
    btn.dataset.quotaWired = '1';
    btn.addEventListener('click', () => openQuotaOverlay());
}

export const __test__ = {
    getQuotaUrl,
    setQuotaUrl,
    renderQuotaInto,
    openQuotaOverlay,
    initQuotaButton,
    QUOTA_URL_KEY,
    DEFAULT_QUOTA_URL,
};
