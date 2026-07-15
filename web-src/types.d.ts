export {};

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
    syncManager: any;
    markdownDirs?: readonly string[];
    updateStatus(...args: any[]): void;
    useExistingTerminalTab?: boolean;
    terminalCommands?: any;
    quickCommands?: any;
    modelPresets?: any;
    hostname?: string;
    applyAccentTheme?: (color: string) => void;
    accentColorSelect?: HTMLSelectElement | null;
    openConfigEditor?: (...args: any[]) => void;
    importCmdsConfig?: (...args: any[]) => void;
    exportTerminalCommandsConfig?: (...args: any[]) => void;
}
