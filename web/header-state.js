// Brand-state helpers — DOM-only utilities that drive the dynamic
// elements of the `.app-header` brand cluster (the Φ glyph, the
// spelled-out "phi" text, the terminal-activity indicator). Both the
// browser Phi page and the desktop main view import from this module
// so the same JS drives the same DOM mutations in both contexts.
//
// The desktop main view can't run the full TabManager (it has no
// terminals), so the helpers are designed to be callable from any
// context that has access to the vendored header DOM. The browser Phi
// page calls them from `web/terminal.js` and `web/app.js`; the desktop
// main view calls them from `web/mainview.js` in response to host IPC.
//
// Pure: no I/O, no state, no dependencies beyond the standard DOM.
// All mutations are guarded against missing elements (return early)
// so a partial page (e.g. the desktop main view before the brand
// cluster is rendered) is safe to call.

// CPU tier thresholds: >90 critical, >70 high, >30 moderate, else idle.
// Mirrors `web/util.js`'s `cpuLevel` — kept here as a private
// implementation detail because the public API takes a CPU percent
// directly, not a tier name, and the helper computes the tier
// itself. The thresholds are intentionally duplicated so this module
// can be loaded in isolation (no dependency on `util.js`).
function cpuLevel(cpuPercent) {
    if (cpuPercent > 90) return 'cpu-critical';
    if (cpuPercent > 70) return 'cpu-high';
    if (cpuPercent > 30) return 'cpu-moderate';
    return 'cpu-idle';
}

/** Apply the brand-logo CPU-tier class to the `.brand .logo` and
 *  `.brand .brand-name` elements. Idempotent: returns early if the
 *  tier hasn't changed since the last call (the threshold transitions
 *  are the only state changes worth re-rendering).
 *
 *  The browser Phi page calls this on every CPU poll (every ~2s).
 *  The desktop main view calls this on every `phi:header-state` IPC
 *  push from the host, which polls the active profile's body
 *  webContents for CPU and forwards the reading.
 *
 *  @param cpuPercent  CPU utilisation percentage (0..100). Out-of-
 *                    range values are clamped to the closest bound. */
export function applyBrandCpuTier(cpuPercent) {
    const logo = document.querySelector('.brand .logo');
    const brandName = document.querySelector('.brand .brand-name');
    if (!logo) return;
    const clamped = Math.max(0, Math.min(100, Number(cpuPercent) || 0));
    const level = cpuLevel(clamped);
    // dataset.cpuPct is read by the self-state HUD on hover; keep it
    // fresh so the HUD's CPU line is accurate even when no tier
    // change occurred.
    logo.dataset.cpuPct = String(clamped);
    if (logo.dataset.cpuLevel === level) return false;
    const first = logo.dataset.cpuLevel === undefined;
    for (const el of [logo, brandName]) {
        if (!el) continue;
        el.classList.remove('cpu-idle', 'cpu-moderate', 'cpu-high', 'cpu-critical');
        el.classList.add(level);
        el.dataset.cpuLevel = level;
    }
    // Returns a status string so the caller can decide whether to play
    // the tier-change flourish animation:
    //   - 'first':    this is the first classification (no flourish;
    //                 loading shouldn't pop)
    //   - 'changed':  the tier just changed (caller may flourish)
    //   - 'unchanged': the tier is the same as last call (no flourish)
    return first ? 'first' : 'changed';
}

/** Toggle the `#terminal-activity-indicator` between quiet and active
 *  states. The indicator sits between the brand "phi" text and the
 *  hostname display and reads as an em-dash (`—`) when no terminal
 *  tab is producing output, a block-pipe (`▍`) when any tab is.
 *
 *  The browser Phi page calls this from `web/terminal.js` on every
 *  terminal activity event. The desktop main view calls this on every
 *  `phi:header-state` IPC push that includes a `terminalActivity`
 *  flag.
 *
 *  @param hasActivity   true when any terminal tab is producing output.
 *  @param hostnameKnown true when the active server's hostname is
 *                       known (the indicator stays hidden until the
 *                       server's identity resolves). Pass `true` on
 *                       the desktop where the hostname is always
 *                       known by the time the main view is up. */
export function applyTerminalActivityIndicator(hasActivity, hostnameKnown) {
    const indicator = document.getElementById('terminal-activity-indicator');
    if (!indicator) return;
    indicator.classList.toggle('hidden', !hostnameKnown);
    indicator.classList.toggle('is-active', Boolean(hasActivity));
    indicator.textContent = hasActivity ? '\u258D' : '\u2014';
    const label = hasActivity
        ? 'Terminal output on one or more tabs'
        : 'All terminal tabs are quiet';
    indicator.setAttribute('aria-label', label);
    indicator.title = label;
}