export interface ToastOptions {
    type?: 'info' | 'success' | 'error';
    title?: string;
    duration?: number;
    action?: { text: string; callback: () => void };
    readyPaneId?: string;
}

// AppLike is the minimal slice of the (unconverted) App class that
// converted managers read. It grows as more modules convert - each
// field is added the moment a second consumer needs it. Nested
// manager handles stay typed as `any` for this tranche; a richer
// model is the responsibility of the deferred terminal.js / app.js
// conversions.
export interface AppLike {
    showToast(message: string, opts?: ToastOptions): HTMLElement;
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
    /** Modal form builder; resolves with the field values or null. */
    openConfigEditor(options: {
        title: string;
        subtitle?: string;
        fields?: Array<{
            id: string;
            label: string;
            value?: string;
            type?: string;
            placeholder?: string;
            pattern?: string;
            multiline?: boolean;
            required?: boolean;
            monospace?: boolean;
            path?: { startPath: string; relativeTo?: string } | null;
        }>;
        submitLabel?: string;
    }): Promise<Record<string, string> | null>;
    importCmdsConfig?: (...args: any[]) => void;
    exportTerminalCommandsConfig?: (...args: any[]) => void;

    // Members terminal.ts drives. Typed narrowly: each is one call site with
    // a known shape, so a wrong argument fails here rather than at runtime.
    kanbanManager?: {
        openBoard(): Promise<void>;
        cleanup?(): void;
    } | null;
    reviewManager?: {
        cleanup?(): void;
    } | null;
    updateLayoutPosition?: (
        shouldFit?: boolean,
        resetDocumentScroll?: boolean,
    ) => void;
    openTabsDrawer?: () => void;
    setTerminalActivity?: (active: boolean) => void;
    mobileScrollbackRows?: number;
    handlePanelResizeShortcut?: (event: KeyboardEvent) => void;
    removeReadyPane?: (paneId: string) => void;
    dismissToast?: (element: HTMLElement) => void;
    captureToastContext?: () => unknown;
    versionInfo?: {
        version?: string;
        commit?: string;
        date?: string;
        buildSource?: string;
        started_at?: string;
        /** Raw terminal replay protocol this server speaks. */
        terminal_protocol?: string;
    } | null;
    syncRemoteClipboard?: () => void | Promise<void>;
    codersPresetRegistry?: Record<string, unknown>;
    /** Launch-settings store for the current backend. */
    piLaunchStore?: {
        readonly mode: 'pi' | 'psi' | null;
    } | null;
    exportModelsConfig?: (btn: HTMLElement | null) => void;
    importModelsConfig?: (btn: HTMLElement | null) => void;
    exportQuickCommandsConfig?: (btn: HTMLElement | null) => void;
}

// Optional browser bridge installed by web/auth.js. The desktop host uses it
// to install a memory-only v2 token; the socket constructors use it to carry
// that token as one query parameter.
export interface PhiAccessAuthBridge {
    installToken(token: string): boolean;
    completeHostSession?(): Promise<boolean>;
    getAccessToken(): string | null;
    webSocketURL(url: URL): URL;
    // refreshAccessIfDue renews a due credential without a round-trip when the
    // in-memory token is still fresh. Reconnecting sockets call it before a
    // dial so a socket closed at the admitted exp does not redial stale.
    refreshAccessIfDue?(): Promise<void> | undefined;
}

/** The \ keys the settings view edits. Unmodelled keys are read
 *  generically by the settings reconciliation sweep. */
export interface PhiConfig {
    agy_theme_ansi?: boolean;
    auto_reconnect?: 'off' | 'visible';
    claude_dangerously_skip_permissions?: boolean;
    fast_mode?: boolean;
    opencode_idle_stop_minutes?: number;
    pi_bridge_no_inject?: boolean;
    pi_offline?: boolean;
    [key: string]: unknown;
}

declare global {
    interface Navigator {
        /** Chromium-only reduced-entropy hint; absent elsewhere. */
        readonly userAgentData?: { readonly mobile?: boolean };
    }

    interface Window {
        phiAccessAuth?: PhiAccessAuthBridge;
        /** Set by the desktop shell before the page loads. */
        __phiDesktop?: boolean;
        /** Set by App so the sync board and helpers can toast. */
        __phiShowToast?: (message: string, opts?: ToastOptions) => void;
        /** Set by the embedded desktop shell to switch backends. */
        __phiEmbed?: {
            switchTo(id: string, origin?: string): Promise<boolean>;
            forget(id: string): void;
        };
    }
}
