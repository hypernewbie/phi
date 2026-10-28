export interface ToastOptions {
    type?: 'info' | 'success' | 'error';
    title?: string;
    duration?: number;
    action?: { text: string; callback: () => void };
}

// AppLike is the minimal slice of the (unconverted) App class that
// converted managers read. It grows as more modules convert - each
// field is added the moment a second consumer needs it. Nested
// manager handles stay typed as `any` for this tranche; a richer
// model is the responsibility of the deferred terminal.js / app.js
// conversions.
export interface AppLike {
    showToast(message: string, opts?: ToastOptions): void;
    sessionsManager: any;
    tabManager: any;
    diffController: any;
    markdownManager: any;
    fileTreeManager: any;
    syncManager: any;
    markdownDirs?: readonly string[];
    // updateStatus is a data property (the latest response from /api/update/status),
    // not a function. Typed as `any` because the wire shape is defined
    // server-side in api_update.go and not formally mirrored here yet.
    updateStatus?: any;
    useExistingTerminalTab?: boolean;
    useHiddenTerminal?: boolean;
    // Raw /api/config response, mirrored by SessionsManager.loadConfig so
    // unconverted modules (terminal.js gates auto-reconnect on it) can read
    // it without reaching through sessionsManager.
    config?: any;
    terminalCommands?: any;
    quickCommands?: any;
    modelPresets?: any;
    hostname?: string;
    applyAccentTheme?: (color: string) => void;
    applyUIFont?: () => void;
    applyFastMode?: () => void;
    uiFontFamily?: string;
    scope?: any;
    getActiveStore?: (profileId?: string) => any;
    uiFontSize?: number;
    terminalFontFamily?: string;
    terminalFontSize?: number;
    // Alternate server hostname for socket URLs (blank = page host).
    hostnameOverride?: string;
    custom_font_name?: string;
    customFontName?: string;
    loadCustomFont?: () => Promise<void>;
    terminalBgName?: string;
    terminalBgDarkness?: number;
    terminalBgBlur?: number;
    loadCustomBg?: () => Promise<void>;
    applyTerminalBg?: (blob: any) => void;
    applyTerminalBgStyles?: () => void;
    clearCustomBg?: () => Promise<void>;
    openConfigEditor?: (...args: any[]) => Promise<any>;
    importCmdsConfig?: (...args: any[]) => void;
    exportTerminalCommandsConfig?: (...args: any[]) => void;
}

// Optional browser bridge installed by web/auth.js. The desktop host uses it
// to install a memory-only v2 token; the socket constructors use it to carry
// that token as one query parameter; asset consumers use it to load protected
// bytes the DOM cannot authenticate on its own.
export interface PhiAccessAuthBridge {
    installToken(token: string): boolean;
    getAccessToken(): string | null;
    webSocketURL(url: URL): URL;
    assetURL(url: string | URL): Promise<{ url: string; revoke(): void }>;
    // refreshAccessIfDue renews a due credential without a round-trip when the
    // in-memory token is still fresh. Reconnecting sockets call it before a
    // dial so a socket closed at the admitted exp does not redial stale.
    refreshAccessIfDue?(): Promise<void>;
}

declare global {
    interface Window {
        phiAccessAuth?: PhiAccessAuthBridge;
    }
}
