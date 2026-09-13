// Desktop hosts may claim an action; browsers keep the existing fallback.
const NATIVE_POPOUT_PAGES = {
    // The config page needs to close its owning native popup, not merely
    // unmount its full-page settings overlay (which leaves a black window).
    config: '/config.html?desktop-popout=1',
    help: '/md.html?page=help',
    changelog: '/md.html?page=changelog',
};
export function markDesktopView() {
    if (new URLSearchParams(location.search).get('desktop') === '1') {
        document.documentElement.setAttribute('data-phi-desktop', '');
    }
}
export function tryNative(kind, payload) {
    const bridge = window.__phiDesktop;
    if (bridge && typeof bridge.request === 'function') {
        bridge.request(kind, payload);
        return true;
    }
    if (new URLSearchParams(location.search).get('desktop') === '1') {
        const url = NATIVE_POPOUT_PAGES[kind];
        if (!url)
            return false;
        const win = window.open(url, `phi-${kind}`, 'width=860,height=1000');
        if (!win)
            return false;
        win.opener = null;
        return true;
    }
    return false;
}
