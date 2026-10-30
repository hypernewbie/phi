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
    const params = new URLSearchParams(location.search);
    const embedded = params.get('embedded') === '1' || location.protocol === 'phi-app:';
    const bridge = window.__phiDesktop;
    if (bridge && typeof bridge.request === 'function') {
        // Older native bridges cannot hand ownership to a config popup.
        if (kind === 'config' && embedded)
            return false;
        bridge.request(kind, payload);
        return true;
    }
    if (params.get('desktop') === '1') {
        let url = NATIVE_POPOUT_PAGES[kind];
        let name = `phi-${kind}`;
        if (!url)
            return false;
        if (kind === 'config') {
            const query = new URLSearchParams('desktop-popout=1');
            if (payload?.page === 'mobile')
                query.set('page', 'mobile');
            if (embedded) {
                const profile = params.get('profile'), origin = params.get('origin');
                if (!profile || !origin)
                    return false;
                query.set('embedded', '1');
                query.set('profile', profile);
                query.set('origin', origin);
                name += `-${encodeURIComponent(profile)}-${encodeURIComponent(origin)}`;
            }
            url = `/config.html?${query}`;
        }
        const win = window.open(url, name, 'width=860,height=1000');
        if (!win)
            return false;
        win.opener = null;
        return true;
    }
    return false;
}
