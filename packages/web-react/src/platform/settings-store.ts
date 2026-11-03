import type { CredentialBundle } from '@phi/core';
import type { SettingsMessageId } from '../copy/settings.ts';
import { applyAccentTheme } from './accent-theme.ts';
import type { AppearanceScope, ProfileOverride } from './appearance-scope.ts';
import {
    appearanceOwner,
    currentProfile,
    isNativeContext,
    legacyAppearanceKey,
    readAppearanceScope,
    readProfileOverride,
    writeProfileOverride,
} from './appearance-scope.ts';
import {
    applyAppearanceFonts,
    removePrepaintNode,
} from './appearance-apply.ts';
import { readCustomFontName } from './appearance-assets.ts';
import { broadcastConfigSync } from './config-sync.ts';
import type {
    ConfigDocument,
    ConnectionService,
    TogglePath,
    VersionDocument,
} from './http.ts';
import { configDocumentSchema } from './http.ts';

export interface SettingsAbout {
    readonly hostname: string;
    readonly buildSource: string;
    readonly workspaces: number;
    readonly version: string;
    readonly commit: string;
    readonly date: string;
}

export interface SettingsControls {
    readonly hidden: boolean;
    readonly reuse: boolean;
    readonly reuseDisabled: boolean;
    readonly autoReconnect: boolean;
    readonly piOffline: boolean;
    readonly piBridgeNoInject: boolean;
    readonly claudeSkip: boolean;
    readonly agyTheme: boolean;
    readonly idleMinutes: number;
    readonly lowPower: boolean;
    readonly hostnameOverride: string;
}

export interface AppearanceControls {
    readonly themeColor: string;
    readonly uiFontFamily: string;
    readonly uiFontSize: number;
    readonly terminalFontFamily: string;
    readonly terminalFontSize: number;
    readonly mobileScrollbackRows: number;
    readonly profile: ProfileOverride;
    readonly profileNative: boolean;
    readonly profileMemoryOnly: boolean;
    readonly customFontName: string;
}

export type SecurityError =
    | 'too-short'
    | 'mismatch'
    | 'too-long'
    | 'sign-in'
    | 'rate-limited'
    | 'save-failed'
    | 'clear-failed';

export type SecurityDone = 'updated' | 'removed';

export interface SecurityControls {
    readonly enabled: boolean;
    readonly busy: boolean;
    readonly error: SecurityError | null;
    readonly done: SecurityDone | null;
}

export interface SecurityHooks {
    protection(): 'enabled' | 'disabled' | 'unknown';
    adoptBundle(bundle: CredentialBundle): void;
    accessDisabled(): void;
}

export interface SettingsView {
    readonly ready: boolean;
    readonly pending: boolean;
    readonly about: SettingsAbout | null;
    readonly controls: SettingsControls;
    readonly appearance: AppearanceControls;
    readonly security: SecurityControls;
    readonly note: SettingsMessageId | null;
}

export interface SettingsStore {
    view(): SettingsView;
    start(listener: (view: SettingsView) => void): () => void;
    retry(): void;
    setToggle(key: ToggleKey, checked: boolean): void;
    setIdleMinutes(minutes: number): void;
    setLowPower(enabled: boolean): void;
    setHostnameOverride(text: string): void;
    setUIFontFamily(family: string): void;
    setUIFontSize(raw: string): void;
    setTerminalFontFamily(family: string): void;
    setTerminalFontSize(raw: string): void;
    setMobileScrollback(raw: string): void;
    setThemeColor(color: string): void;
    setProfile(profile: ProfileOverride): void;
    resetAppearance(): void;
    setAccessPassword(newPassword: string, confirmPassword: string): void;
    clearAccessPassword(): void;
    dismissSecurity(): void;
}

export type ToggleKey =
    | 'hidden'
    | 'reuse'
    | 'autoReconnect'
    | 'piOffline'
    | 'piBridgeNoInject'
    | 'claudeSkip'
    | 'agyTheme';

type EditableKey = ToggleKey | 'idleMinutes' | 'hostnameOverride';

const CACHE_PREFIX = 'phi:settings-config:v1:';
const CACHE_SCHEMA = 1;
const LOW_POWER_KEY = 'phi_low_power';

type CacheStorage =
    | Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
    | null
    | undefined;

type Broadcaster = (type: string, payload?: Record<string, unknown>) => void;

const defaultBroadcast: Broadcaster = (type, payload = {}) =>
    broadcastConfigSync(type, payload);

// Legacy parity: only these saves announce; the rest are silent.
const ANNOUNCED_TOGGLES: ReadonlySet<ToggleKey> = new Set([
    'hidden',
    'reuse',
    'autoReconnect',
]);

const APPEARANCE_DEBOUNCE_MS = 300;

const parseIntIn = (raw: string, min: number, max: number): number | null => {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

// Blank means full history; otherwise 0 or 500..10000. Out-of-range
// input is ignored, never half-applied (web/settings.js).
const parseScrollback = (raw: string): number | null => {
    const trimmed = raw.trim();
    if (trimmed === '') return 0;
    const n = parseInt(trimmed, 10);
    if (!Number.isFinite(n) || n < 0 || n > 10000) return null;
    if (n !== 0 && n < 500) return null;
    return n;
};

const APPEARANCE_ZEROS = {
    ui_font_family: '',
    ui_font_size: 0,
    terminal_font_family: '',
    terminal_font_size: 0,
} as const;

const TOGGLE_PATHS: Record<ToggleKey, TogglePath> = {
    hidden: '/api/config/use-hidden-terminal',
    reuse: '/api/config/use-existing-terminal-tab',
    autoReconnect: '/api/config/auto-reconnect',
    piOffline: '/api/config/pi-offline',
    piBridgeNoInject: '/api/config/pi-bridge-no-inject',
    claudeSkip: '/api/config/claude-dangerously-skip-permissions',
    agyTheme: '/api/config/agy-theme-ansi',
};

function readCachedConfig(
    storage: CacheStorage,
    key: string,
): ConfigDocument | null {
    if (storage === null || storage === undefined) return null;
    let raw: string | null;
    try {
        raw = storage.getItem(key);
    } catch {
        return null;
    }
    if (raw === null) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { schema, config } = parsed as Record<string, unknown>;
    if (schema !== CACHE_SCHEMA) return null;
    const validated = configDocumentSchema.safeParse(config);
    return validated.success ? validated.data : null;
}

export function createSettingsStore(
    http: ConnectionService,
    bearer: () => string | null,
    storage: CacheStorage = globalThis.localStorage,
    broadcast: Broadcaster = defaultBroadcast,
    scopeInput?: AppearanceScope | null,
    securityHooks?: SecurityHooks,
): SettingsStore {
    const cacheKey = `${CACHE_PREFIX}${http.serverLabel}`;
    const scope = scopeInput === undefined ? readAppearanceScope() : scopeInput;
    const owner = scope === null ? null : appearanceOwner(scope);
    const appearanceKey = scope === null ? null : legacyAppearanceKey(scope);
    let listener: ((view: SettingsView) => void) | null = null;
    let config: ConfigDocument | null = null;
    let version: VersionDocument | null = null;
    let pending = false;
    let note: SettingsMessageId | null = null;
    let controller: AbortController | null = null;
    let saveController: AbortController | null = null;
    const edited = new Set<EditableKey>();
    let lowPower: boolean | null = null;
    let uiFontFamily = '';
    let uiFontSize = 0;
    let terminalFontFamily = '';
    let terminalFontSize = 0;
    let mobileScrollbackRows = 0;
    let customFontName = '';
    let themeColor = 'purple';
    let themeEdited = false;
    let profile: ProfileOverride = readProfileOverride(storage);
    let profileMemoryOnly = false;
    let securityEnabled = false;
    let securityBusy = false;
    let securityError: SecurityError | null = null;
    let securityDone: SecurityDone | null = null;
    const profileNative = scope === null ? false : isNativeContext();

    const readLowPowerLocal = (): boolean | null => {
        if (storage === null || storage === undefined) return null;
        try {
            const raw = storage.getItem(LOW_POWER_KEY);
            if (raw === '1') return true;
            if (raw === '0') return false;
            return null;
        } catch {
            return null;
        }
    };
    // Browser preference wins; otherwise the legacy server flag seeds the
    // checkbox once and migrates into local storage. Matches legacy
    // resolveLowPowerEnabled, including the same storage key.
    const resolveLowPower = (serverFastMode: boolean): boolean => {
        const local = readLowPowerLocal();
        if (local !== null) return local;
        if (serverFastMode) {
            try {
                storage?.setItem(LOW_POWER_KEY, '1');
            } catch {
                // Migration is best-effort; the rendered state stands.
            }
            return true;
        }
        return false;
    };
    const controls = (): SettingsControls => {
        const hidden = config?.hiddenTerminal ?? false;
        return {
            hidden,
            reuse: config?.reuseTab ?? false,
            reuseDisabled: hidden,
            autoReconnect:
                config === null ? true : config.autoReconnect === 'visible',
            piOffline: config?.piOffline ?? false,
            piBridgeNoInject: config?.piBridgeNoInject ?? false,
            claudeSkip: config?.claudeSkipPermissions ?? false,
            agyTheme: config?.agyThemeAnsi ?? false,
            idleMinutes: config?.opencodeIdleMinutes ?? 0,
            lowPower: lowPower ?? readLowPowerLocal() ?? false,
            hostnameOverride: config?.hostnameOverride ?? '',
        };
    };
    const appearance = (): AppearanceControls => ({
        themeColor,
        uiFontFamily,
        uiFontSize,
        terminalFontFamily,
        terminalFontSize,
        mobileScrollbackRows,
        profile,
        profileNative,
        profileMemoryOnly,
        customFontName,
    });
    const security = (): SecurityControls => ({
        enabled: securityEnabled,
        busy: securityBusy,
        error: securityError,
        done: securityDone,
    });
    const view = (): SettingsView => ({
        ready: config !== null,
        pending,
        appearance: appearance(),
        security: security(),
        about:
            config === null
                ? null
                : {
                      hostname: config.hostname.toUpperCase(),
                      buildSource: version?.buildSource ?? '',
                      workspaces: config.workspaces.length,
                      version: version?.version ?? '',
                      commit: version?.commit ?? '',
                      date: version?.date ?? '',
                  },
        controls: controls(),
        note,
    });
    const emit = () => {
        if (listener !== null) listener(view());
    };
    const writeCache = (document: ConfigDocument): void => {
        if (storage === null || storage === undefined) return;
        try {
            storage.setItem(
                cacheKey,
                JSON.stringify({ schema: CACHE_SCHEMA, config: document }),
            );
        } catch {
            // Cache is best-effort; the rendered state stands without it.
        }
    };
    const readAppearanceLocal = (): Record<string, unknown> => {
        if (storage === null || storage === undefined) return {};
        if (appearanceKey === null) return {};
        try {
            const raw = storage.getItem(appearanceKey);
            if (raw === null) return {};
            const parsed: unknown = JSON.parse(raw);
            if (typeof parsed !== 'object' || parsed === null) return {};
            return parsed as Record<string, unknown>;
        } catch {
            return {};
        }
    };
    // Legacy ingestAppearance: browser storage wins field by field, the
    // server only seeds what the browser never wrote.
    const resolveAppearance = (server: ConfigDocument | null): void => {
        const local = readAppearanceLocal();
        const text = (value: unknown, seed: string): string =>
            typeof value === 'string' ? value : seed;
        const size = (value: unknown, seed: number): number => {
            if (value === undefined || value === null) return seed;
            try {
                return Number(value) || 0;
            } catch {
                return 0;
            }
        };
        uiFontFamily = text(local.ui_font_family, server?.uiFontFamily ?? '');
        uiFontSize = size(local.ui_font_size, server?.uiFontSize ?? 0);
        terminalFontFamily = text(
            local.terminal_font_family,
            server?.terminalFontFamily ?? '',
        );
        terminalFontSize = size(
            local.terminal_font_size,
            server?.terminalFontSize ?? 0,
        );
        mobileScrollbackRows = size(
            local.mobile_scrollback_rows,
            server?.mobileScrollbackRows ?? 0,
        );
        customFontName = readCustomFontName(local);
        applyAppearanceFonts(currentProfile(), {
            ui_font_family: uiFontFamily,
            ui_font_size: uiFontSize,
        });
        if (!themeEdited) {
            // Empty server color keeps the purple boot default, matching
            // prepaint plus the config.js truthy guard.
            themeColor = server?.themeColor || 'purple';
            if (scope !== null)
                applyAccentTheme(themeColor, scope.profileId, storage);
        }
    };
    // Refresh merge: edited keys keep the user's value, the rest take the
    // server's. Low power is local truth and never merges.
    const merge = (next: ConfigDocument): ConfigDocument => {
        if (config === null || edited.size === 0) return next;
        return {
            ...next,
            hiddenTerminal: edited.has('hidden')
                ? config.hiddenTerminal
                : next.hiddenTerminal,
            reuseTab: edited.has('reuse') ? config.reuseTab : next.reuseTab,
            autoReconnect: edited.has('autoReconnect')
                ? config.autoReconnect
                : next.autoReconnect,
            piOffline: edited.has('piOffline')
                ? config.piOffline
                : next.piOffline,
            piBridgeNoInject: edited.has('piBridgeNoInject')
                ? config.piBridgeNoInject
                : next.piBridgeNoInject,
            claudeSkipPermissions: edited.has('claudeSkip')
                ? config.claudeSkipPermissions
                : next.claudeSkipPermissions,
            agyThemeAnsi: edited.has('agyTheme')
                ? config.agyThemeAnsi
                : next.agyThemeAnsi,
            opencodeIdleMinutes: edited.has('idleMinutes')
                ? config.opencodeIdleMinutes
                : next.opencodeIdleMinutes,
            hostnameOverride: edited.has('hostnameOverride')
                ? config.hostnameOverride
                : next.hostnameOverride,
        };
    };
    const load = async (): Promise<void> => {
        if (listener === null || pending) return;
        pending = true;
        emit();
        const own = new AbortController();
        controller = own;
        const token = bearer();
        const credential = token === null ? undefined : token;
        const [configOutcome, versionOutcome] = await Promise.all([
            http.getConfigDocument(own.signal, credential),
            http.getVersion(own.signal, credential),
        ]);
        if (controller !== own) return;
        controller = null;
        if (configOutcome.kind === 'ok') {
            config = merge(configOutcome.document);
            // The hostname label is appearance state: browser truth wins
            // over the server mirror on every load.
            const localHostname = readAppearanceLocal().hostname_override;
            if (typeof localHostname === 'string') {
                config = { ...config, hostnameOverride: localHostname };
                edited.add('hostnameOverride');
            }
            lowPower = resolveLowPower(config.fastMode);
            resolveAppearance(config);
            note = null;
            writeCache(config);
        } else if (configOutcome.kind !== 'cancelled') {
            note = config === null ? 'settings-unavailable' : 'settings-stale';
        }
        // Version failure is silent: the header falls back to v?.
        if (versionOutcome.kind === 'ok') version = versionOutcome.document;
        pending = false;
        emit();
    };
    const announce = (
        type: string,
        payload: Record<string, unknown> = {},
    ): void => {
        if (owner === null) return;
        broadcast(type, { owner, ...payload });
    };
    const save = (
        path: TogglePath,
        body: string,
        sync: 'behavior' | null,
    ): void => {
        const saves = saveController;
        if (saves === null) return;
        const token = bearer();
        void http
            .postConfig(
                path,
                body,
                saves.signal,
                token === null ? undefined : token,
            )
            .then((outcome) => {
                if (outcome.kind === 'ok') {
                    if (sync !== null) announce(sync);
                } else if (outcome.kind !== 'cancelled')
                    console.warn(
                        `[settings] save failed: ${path} (${outcome.kind})`,
                    );
            })
            .catch(() => {});
    };
    // Appearance writes go to browser storage immediately (browser is
    // truth); the server mirror follows after 300 ms of quiet.
    let persistTimer: ReturnType<typeof setTimeout> | null = null;
    let appearancePatch: Record<string, unknown> = {};
    const writeAppearanceLocal = (patch: Record<string, unknown>): void => {
        if (storage === null || storage === undefined) return;
        if (appearanceKey === null) return;
        let current: Record<string, unknown> = {};
        try {
            const raw = storage.getItem(appearanceKey);
            if (raw !== null) {
                const parsed: unknown = JSON.parse(raw);
                if (typeof parsed === 'object' && parsed !== null)
                    current = parsed as Record<string, unknown>;
            }
            storage.setItem(
                appearanceKey,
                JSON.stringify({ ...current, ...patch }),
            );
        } catch {
            // Local mirror is best-effort; the rendered state stands.
        }
    };
    const flushAppearance = (): void => {
        persistTimer = null;
        const fields = appearancePatch;
        appearancePatch = {};
        if (Object.keys(fields).length === 0) return;
        const saves = saveController;
        if (saves !== null) {
            const token = bearer();
            void http
                .postAppearance(
                    JSON.stringify(fields),
                    saves.signal,
                    token === null ? undefined : token,
                )
                .then((outcome) => {
                    if (outcome.kind !== 'ok' && outcome.kind !== 'cancelled')
                        console.warn(
                            `[settings] appearance save failed (${outcome.kind})`,
                        );
                })
                .catch(() => {});
        }
        // The broadcast follows the local write, not the mirror:
        // receivers re-read browser storage.
        announce('appearance');
    };
    const debouncedAppearance = (fields: Record<string, unknown>): void => {
        appearancePatch = { ...appearancePatch, ...fields };
        if (persistTimer !== null) clearTimeout(persistTimer);
        persistTimer = setTimeout(flushAppearance, APPEARANCE_DEBOUNCE_MS);
    };
    const setDocument = (next: ConfigDocument): void => {
        config = next;
        emit();
    };
    // Enabled state comes from a fresh status read, never a local echo.
    const refreshSecurityEnabled = (): void => {
        const saves = saveController;
        if (saves === null) return;
        const token = bearer();
        void http
            .getAuthStatus(saves.signal, token === null ? undefined : token)
            .then((status) => {
                if (status.kind === 'ok') {
                    securityEnabled = status.status.enabled;
                    emit();
                }
            })
            .catch(() => {});
    };
    const rejectedSecurityError = (
        status: number,
        generic: SecurityError,
    ): SecurityError => {
        if (status === 401) return 'sign-in';
        if (status === 429) return 'rate-limited';
        return generic;
    };
    return {
        view,
        start: (onView) => {
            listener = onView;
            saveController = new AbortController();
            securityEnabled = securityHooks?.protection() === 'enabled';
            securityBusy = false;
            securityError = null;
            securityDone = null;
            if (owner === null) {
                note = 'settings-unavailable';
                emit();
                return () => {
                    listener = null;
                    saveController?.abort();
                    saveController = null;
                };
            }
            const cached = readCachedConfig(storage, cacheKey);
            if (cached !== null) {
                config = cached;
                lowPower = resolveLowPower(cached.fastMode);
                resolveAppearance(cached);
            }
            emit();
            void load().catch(() => {});
            return () => {
                listener = null;
                controller?.abort();
                controller = null;
                saveController?.abort();
                saveController = null;
                if (persistTimer !== null) {
                    clearTimeout(persistTimer);
                    persistTimer = null;
                }
                pending = false;
            };
        },
        retry: () => {
            void load().catch(() => {});
        },
        setToggle: (key, checked) => {
            if (listener === null || config === null) return;
            const current = controls();
            if (key === 'reuse' && current.reuseDisabled) return;
            if (current[key] === checked) return;
            edited.add(key);
            const patch: Record<ToggleKey, Partial<ConfigDocument>> = {
                hidden: { hiddenTerminal: checked },
                reuse: { reuseTab: checked },
                autoReconnect: {
                    autoReconnect: checked ? 'visible' : 'off',
                },
                piOffline: { piOffline: checked },
                piBridgeNoInject: { piBridgeNoInject: checked },
                claudeSkip: { claudeSkipPermissions: checked },
                agyTheme: { agyThemeAnsi: checked },
            };
            setDocument({ ...config, ...patch[key] });
            save(
                TOGGLE_PATHS[key],
                JSON.stringify({ enabled: checked }),
                ANNOUNCED_TOGGLES.has(key) ? 'behavior' : null,
            );
        },
        setIdleMinutes: (minutes) => {
            if (listener === null || config === null) return;
            if (!Number.isInteger(minutes) || minutes < 0) return;
            if (config.opencodeIdleMinutes === minutes) return;
            edited.add('idleMinutes');
            setDocument({ ...config, opencodeIdleMinutes: minutes });
            save(
                '/api/config/opencode-idle-stop',
                JSON.stringify({ minutes }),
                null,
            );
        },
        setLowPower: (enabled) => {
            if (listener === null) return;
            lowPower = enabled;
            try {
                storage?.setItem(LOW_POWER_KEY, enabled ? '1' : '0');
            } catch {
                console.warn('[settings] failed to persist low-power toggle');
            }
            emit();
            announce('low-power', { enabled });
        },
        setHostnameOverride: (text) => {
            if (listener === null || config === null) return;
            const trimmed = text.trim();
            if (config.hostnameOverride === trimmed) return;
            edited.add('hostnameOverride');
            setDocument({ ...config, hostnameOverride: trimmed });
            writeAppearanceLocal({ hostname_override: trimmed });
            debouncedAppearance({ hostname_override: trimmed });
        },
        setUIFontFamily: (family) => {
            if (listener === null || config === null) return;
            if (uiFontFamily === family) return;
            uiFontFamily = family;
            applyAppearanceFonts(currentProfile(), {
                ui_font_family: uiFontFamily,
                ui_font_size: uiFontSize,
            });
            writeAppearanceLocal({ ui_font_family: family });
            debouncedAppearance({ ui_font_family: family });
            emit();
        },
        setUIFontSize: (raw) => {
            if (listener === null || config === null) return;
            const size = parseIntIn(raw, 10, 24);
            if (size === null || size === uiFontSize) return;
            uiFontSize = size;
            applyAppearanceFonts(currentProfile(), {
                ui_font_family: uiFontFamily,
                ui_font_size: uiFontSize,
            });
            writeAppearanceLocal({ ui_font_size: size });
            debouncedAppearance({ ui_font_size: size });
            emit();
        },
        setTerminalFontFamily: (family) => {
            if (listener === null || config === null) return;
            if (terminalFontFamily === family) return;
            terminalFontFamily = family;
            writeAppearanceLocal({ terminal_font_family: family });
            debouncedAppearance({ terminal_font_family: family });
            emit();
        },
        setTerminalFontSize: (raw) => {
            if (listener === null || config === null) return;
            const size = parseIntIn(raw, 8, 32);
            if (size === null || size === terminalFontSize) return;
            terminalFontSize = size;
            writeAppearanceLocal({ terminal_font_size: size });
            debouncedAppearance({ terminal_font_size: size });
            emit();
        },
        setMobileScrollback: (raw) => {
            if (listener === null || config === null) return;
            const rows = parseScrollback(raw);
            if (rows === null || rows === mobileScrollbackRows) return;
            mobileScrollbackRows = rows;
            writeAppearanceLocal({ mobile_scrollback_rows: rows });
            debouncedAppearance({ mobile_scrollback_rows: rows });
            emit();
        },
        setThemeColor: (color) => {
            if (listener === null || config === null || scope === null) return;
            if (themeColor === color) return;
            themeColor = color;
            themeEdited = true;
            applyAccentTheme(color, scope.profileId, storage);
            emit();
            // Legacy announces the theme with the click, not the POST.
            announce('theme', { color });
            const saves = saveController;
            if (saves === null) return;
            const token = bearer();
            void http
                .postTheme(
                    JSON.stringify({ color }),
                    saves.signal,
                    token === null ? undefined : token,
                )
                .then((outcome) => {
                    if (outcome.kind !== 'ok' && outcome.kind !== 'cancelled')
                        console.warn(
                            `[settings] theme save failed (${outcome.kind})`,
                        );
                })
                .catch(() => {});
        },
        setProfile: (next) => {
            if (listener === null || config === null) return;
            if (profileNative || profile === next) return;
            profile = next;
            profileMemoryOnly = !writeProfileOverride(next, storage);
            applyAppearanceFonts(currentProfile(), {
                ui_font_family: uiFontFamily,
                ui_font_size: uiFontSize,
            });
            emit();
        },
        resetAppearance: () => {
            if (listener === null || config === null) return;
            if (appearanceKey === null) return;
            // Legacy removes the key, then write-throughs zeros while the
            // untouched fields (hostname, assets) survive from memory.
            const preserved = readAppearanceLocal();
            try {
                storage?.removeItem(appearanceKey);
            } catch {
                // Removal is best-effort; the zero write below stands.
            }
            removePrepaintNode();
            uiFontFamily = '';
            uiFontSize = 0;
            terminalFontFamily = '';
            terminalFontSize = 0;
            applyAppearanceFonts(currentProfile(), {
                ui_font_family: '',
                ui_font_size: 0,
            });
            writeAppearanceLocal({ ...preserved, ...APPEARANCE_ZEROS });
            emit();
            // Reset posts immediately and announces at once; a pending
            // debounced patch still flushes after, like legacy.
            const saves = saveController;
            if (saves !== null) {
                const token = bearer();
                void http
                    .postAppearance(
                        JSON.stringify({ ...APPEARANCE_ZEROS }),
                        saves.signal,
                        token === null ? undefined : token,
                    )
                    .then((outcome) => {
                        if (
                            outcome.kind !== 'ok' &&
                            outcome.kind !== 'cancelled'
                        )
                            console.warn(
                                `[settings] appearance reset failed (${outcome.kind})`,
                            );
                    })
                    .catch(() => {});
            }
            announce('appearance');
        },
        setAccessPassword: (newPassword, confirmPassword) => {
            if (listener === null || config === null || securityBusy) return;
            // Local rules first: short and mismatched passwords never
            // reach the network (web/settings.js).
            if (!newPassword || newPassword.length < 8) {
                securityError = 'too-short';
                securityDone = null;
                emit();
                return;
            }
            if (newPassword !== confirmPassword) {
                securityError = 'mismatch';
                securityDone = null;
                emit();
                return;
            }
            const saves = saveController;
            if (saves === null) return;
            securityBusy = true;
            securityError = null;
            securityDone = null;
            emit();
            const token = bearer();
            void http
                .setPassword(
                    newPassword,
                    saves.signal,
                    token === null ? undefined : token,
                )
                .then((outcome) => {
                    securityBusy = false;
                    if (outcome.kind === 'cancelled') {
                        emit();
                        return;
                    }
                    if (outcome.kind === 'ok') {
                        securityHooks?.adoptBundle(outcome.bundle);
                        securityDone = 'updated';
                        refreshSecurityEnabled();
                    } else if (outcome.kind === 'invalid-length') {
                        // The char-length check passed, so only the
                        // 1024-byte cap can fail here.
                        securityError = 'too-long';
                    } else if (outcome.kind === 'rejected') {
                        securityError = rejectedSecurityError(
                            outcome.status,
                            'save-failed',
                        );
                    } else {
                        securityError = 'save-failed';
                    }
                    emit();
                })
                .catch(() => {
                    securityBusy = false;
                    securityError = 'save-failed';
                    emit();
                });
        },
        clearAccessPassword: () => {
            if (listener === null || config === null || securityBusy) return;
            const saves = saveController;
            if (saves === null) return;
            securityBusy = true;
            securityError = null;
            securityDone = null;
            emit();
            const token = bearer();
            void http
                .clearPassword(saves.signal, token === null ? undefined : token)
                .then((outcome) => {
                    securityBusy = false;
                    if (outcome.kind === 'cancelled') {
                        emit();
                        return;
                    }
                    if (outcome.kind === 'ok') {
                        securityDone = 'removed';
                        refreshSecurityEnabled();
                        securityHooks?.accessDisabled();
                    } else if (outcome.kind === 'rejected') {
                        securityError = rejectedSecurityError(
                            outcome.status,
                            'clear-failed',
                        );
                    } else {
                        securityError = 'clear-failed';
                    }
                    emit();
                })
                .catch(() => {
                    securityBusy = false;
                    securityError = 'clear-failed';
                    emit();
                });
        },
        dismissSecurity: () => {
            if (securityError === null && securityDone === null) return;
            securityError = null;
            securityDone = null;
            emit();
        },
    };
}
