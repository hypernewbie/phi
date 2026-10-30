import { COMPACT_VIEWPORT_QUERY, isSidebarDrawerViewport, SIDEBAR_DRAWER_VIEWPORT_QUERY, } from './util.js';
const SIDEBAR_HIDDEN_KEY = 'phi_sidebar_hidden';
export function initDesktopSidebarToggle() {
    const button = document.getElementById('desktop-sidebar-toggle');
    const sidebar = document.getElementById('sidebar-panel');
    const buttonHome = document.getElementById('desktop-sidebar-toggle-home');
    const restoreSlot = document.getElementById('desktop-sidebar-restore-slot');
    if (!button || !sidebar || !buttonHome || !restoreSlot)
        return () => { };
    let hidden = false;
    try {
        hidden = window.localStorage.getItem(SIDEBAR_HIDDEN_KEY) === '1';
    }
    catch {
        // Private browsing or a blocked preference must not block the control.
    }
    const root = document.documentElement;
    const mobileToggle = document.getElementById('mobile-sidebar-toggle');
    let wasDrawer;
    const render = () => {
        const drawer = isSidebarDrawerViewport();
        const focusedButton = button.contains(document.activeElement);
        const focusInSidebar = sidebar.contains(document.activeElement);
        const restore = hidden && !drawer;
        const destination = restore ? restoreSlot : buttonHome;
        if (button.parentElement !== destination)
            destination.appendChild(button);
        restoreSlot.classList.toggle('hidden', !restore);
        root.classList.toggle('desktop-sidebar-hidden', restore);
        button.classList.toggle('hidden', drawer);
        button.textContent = hidden ? '>>' : '<<';
        button.setAttribute('aria-expanded', String(!hidden));
        button.setAttribute('aria-label', hidden ? 'Show sessions' : 'Hide sessions');
        button.title = hidden ? 'Show sessions' : 'Hide sessions';
        if (drawer && wasDrawer === false && focusedButton)
            mobileToggle?.focus({ preventScroll: true });
        else if (!drawer && hidden && (focusInSidebar || focusedButton))
            button.focus({ preventScroll: true });
        else if (!drawer && !hidden && focusedButton)
            button.focus({ preventScroll: true });
        wasDrawer = drawer;
    };
    const toggle = () => {
        hidden = !hidden;
        render();
        try {
            window.localStorage.setItem(SIDEBAR_HIDDEN_KEY, hidden ? '1' : '0');
        }
        catch {
            // Keep the in-memory state when the preference cannot be saved.
        }
    };
    button.addEventListener('click', toggle);
    window.addEventListener('resize', render);
    const mediaQueries = typeof window.matchMedia === 'function'
        ? [
            window.matchMedia(COMPACT_VIEWPORT_QUERY),
            window.matchMedia(SIDEBAR_DRAWER_VIEWPORT_QUERY),
        ]
        : [];
    for (const media of mediaQueries)
        media.addEventListener('change', render);
    render();
    return () => {
        button.removeEventListener('click', toggle);
        window.removeEventListener('resize', render);
        for (const media of mediaQueries)
            media.removeEventListener('change', render);
    };
}
initDesktopSidebarToggle();
