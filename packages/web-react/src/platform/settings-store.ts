import type { SettingsMessageId } from '../copy/settings.ts';
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
}

export interface SettingsView {
    readonly ready: boolean;
    readonly pending: boolean;
    readonly about: SettingsAbout | null;
    readonly controls: SettingsControls;
    readonly note: SettingsMessageId | null;
}

export interface SettingsStore {
    view(): SettingsView;
    start(listener: (view: SettingsView) => void): () => void;
    retry(): void;
    setToggle(key: ToggleKey, checked: boolean): void;
    setIdleMinutes(minutes: number): void;
    setLowPower(enabled: boolean): void;
}

export type ToggleKey =
    | 'hidden'
    | 'reuse'
    | 'autoReconnect'
    | 'piOffline'
    | 'piBridgeNoInject'
    | 'claudeSkip'
    | 'agyTheme';

type EditableKey = ToggleKey | 'idleMinutes';

const CACHE_PREFIX = 'phi:settings-config:v1:';
const CACHE_SCHEMA = 1;
const LOW_POWER_KEY = 'phi_low_power';

type CacheStorage = Pick<Storage, 'getItem' | 'setItem'> | null | undefined;

type Broadcaster = (type: string, payload?: Record<string, unknown>) => void;

const defaultBroadcast: Broadcaster = (type, payload = {}) => {
    try {
        if (typeof BroadcastChannel !== 'undefined') {
            const channel = new BroadcastChannel('phi_config_sync');
            channel.postMessage({ type, ...payload });
            channel.close();
        }
    } catch {
        // Cross-tab sync is best-effort.
    }
};

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
): SettingsStore {
    const cacheKey = `${CACHE_PREFIX}${http.serverLabel}`;
    let listener: ((view: SettingsView) => void) | null = null;
    let config: ConfigDocument | null = null;
    let version: VersionDocument | null = null;
    let pending = false;
    let note: SettingsMessageId | null = null;
    let controller: AbortController | null = null;
    let saveController: AbortController | null = null;
    const edited = new Set<EditableKey>();
    let lowPower: boolean | null = null;

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
        };
    };
    const view = (): SettingsView => ({
        ready: config !== null,
        pending,
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
            lowPower = resolveLowPower(config.fastMode);
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
    const save = (path: TogglePath, body: string): void => {
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
                if (outcome.kind === 'ok') broadcast('behavior');
                else if (outcome.kind !== 'cancelled')
                    console.warn(
                        `[settings] save failed: ${path} (${outcome.kind})`,
                    );
            })
            .catch(() => {});
    };
    const setDocument = (next: ConfigDocument): void => {
        config = next;
        emit();
    };
    return {
        view,
        start: (onView) => {
            listener = onView;
            saveController = new AbortController();
            const cached = readCachedConfig(storage, cacheKey);
            if (cached !== null) {
                config = cached;
                lowPower = resolveLowPower(cached.fastMode);
            }
            emit();
            void load().catch(() => {});
            return () => {
                listener = null;
                controller?.abort();
                controller = null;
                saveController?.abort();
                saveController = null;
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
            save(TOGGLE_PATHS[key], JSON.stringify({ enabled: checked }));
        },
        setIdleMinutes: (minutes) => {
            if (listener === null || config === null) return;
            if (!Number.isInteger(minutes) || minutes < 0) return;
            if (config.opencodeIdleMinutes === minutes) return;
            edited.add('idleMinutes');
            setDocument({ ...config, opencodeIdleMinutes: minutes });
            save('/api/config/opencode-idle-stop', JSON.stringify({ minutes }));
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
            broadcast('low-power', { enabled });
        },
    };
}
