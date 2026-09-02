export interface ToastOptions {
    type?: 'info' | 'success' | 'error';
    title?: string;
    duration?: number;
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
    uiFontSize?: number;
    terminalFontFamily?: string;
    terminalFontSize?: number;
    customFontName?: string;
    loadCustomFont?: () => Promise<void>;
    openConfigEditor?: (...args: any[]) => void;
    importCmdsConfig?: (...args: any[]) => void;
    exportTerminalCommandsConfig?: (...args: any[]) => void;
}
