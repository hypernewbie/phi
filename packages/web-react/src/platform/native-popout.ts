// Native popout claim. Port of tryNative('config') from
// web/desktop.js:22-72: a desktop bridge may claim the settings
// action, else a native host (?desktop=1) gets a window.open popup.
// Browsers keep the existing modal fallback. Desktop hosts are also
// listed in web/desktop.js (help/changelog); v2 only needs config.
export type PopoutPage = 'desktop' | 'mobile';

export interface PopoutBridge {
    request(kind: string, payload: unknown): void;
}

export interface PopoutWindow {
    opener: unknown;
}

export interface PopoutDeps {
    /** location.search */
    search: string;
    /** location.protocol */
    protocol: string;
    /** location.pathname, for the popout URL */
    pathname: string;
    /** documentElement.dataset.phiDesktopFullscreen === 'true' */
    fullscreen: boolean;
    /** window.__phiDesktop when present */
    bridge: PopoutBridge | null;
    /** window.open */
    open: (
        url: string,
        name: string,
        features: string,
    ) => PopoutWindow | null;
    /** window.close */
    close: () => void;
}

export function defaultPopoutDeps(): PopoutDeps {
    const bridge = (window as unknown as Record<string, unknown>)[
        '__phiDesktop'
    ];
    return {
        search: location.search,
        protocol: location.protocol,
        pathname: location.pathname,
        fullscreen:
            document.documentElement.dataset.phiDesktopFullscreen === 'true',
        bridge:
            typeof bridge === 'object' &&
            bridge !== null &&
            typeof (bridge as PopoutBridge).request === 'function'
                ? (bridge as PopoutBridge)
                : null,
        open: (url, name, features) => window.open(url, name, features),
        close: () => window.close(),
    };
}

export function isPopoutClose(search: string): boolean {
    return new URLSearchParams(search).get('desktop-popout') === '1';
}

export function isPopoutCloseNow(): boolean {
    return isPopoutClose(location.search);
}

// Returns true when a native surface claimed the settings action and
// the modal must stay shut.
export function tryOpenNative(page: PopoutPage, deps: PopoutDeps): boolean {
    if (deps.fullscreen) return false;
    const params = new URLSearchParams(deps.search);
    const embedded =
        params.get('embedded') === '1' || deps.protocol === 'phi-app:';
    if (deps.bridge !== null) {
        // Older native bridges cannot hand ownership to a config popup.
        if (embedded) return false;
        deps.bridge.request('config', { page });
        return true;
    }
    if (params.get('desktop') !== '1') return false;
    const query = new URLSearchParams('desktop-popout=1');
    if (page === 'mobile') query.set('page', 'mobile');
    let name = 'phi-config';
    if (embedded) {
        const profile = params.get('profile');
        const origin = params.get('origin');
        if (!profile || !origin) return false;
        query.set('embedded', '1');
        query.set('profile', profile);
        query.set('origin', origin);
        name += `-${encodeURIComponent(profile)}-${encodeURIComponent(origin)}`;
    }
    const win = deps.open(
        `${deps.pathname}?${query}`,
        name,
        'width=860,height=1000',
    );
    if (!win) return false;
    win.opener = null;
    return true;
}

export function closePopout(deps: PopoutDeps): void {
    deps.close();
}
