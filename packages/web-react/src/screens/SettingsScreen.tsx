import styles from '../app.module.css';
import { Button } from '../components/ui/Button.tsx';
import settings from './settings.module.css';
import {
    StatusMessage,
    type StatusKind,
} from '../components/ui/StatusMessage.tsx';
import { settingsCopy } from '../copy/settings.ts';
import type { SettingsView, ToggleKey } from '../platform/settings-store.ts';

function versionText(about: SettingsView['about']): string {
    if (about === null || about.version === '') return 'v?';
    const short = about.commit.slice(0, 7);
    return short === '' ? `v${about.version}` : `v${about.version} · ${short}`;
}

// Mirrors the legacy tooltip: date plus build source, or 'unknown build'.
function versionTitle(about: SettingsView['about']): string {
    if (about === null) return settingsCopy.unknownBuild;
    return (
        [about.date, about.buildSource]
            .filter((part) => part !== '')
            .join(' · ') || settingsCopy.unknownBuild
    );
}

export function SettingsScreen({
    view,
    onRetry,
    onToggle,
    onIdleMinutes,
    onLowPower,
}: {
    view: SettingsView;
    onRetry: () => void;
    onToggle: (key: ToggleKey, checked: boolean) => void;
    onIdleMinutes: (minutes: number) => void;
    onLowPower: (enabled: boolean) => void;
}) {
    const controls = view.controls;
    const checkbox = (key: ToggleKey, checked: boolean, label: string) => (
        <label className={settings.check}>
            <input
                type="checkbox"
                checked={checked}
                onChange={(event) => onToggle(key, event.target.checked)}
            />{' '}
            {label}
        </label>
    );
    const noteKind: StatusKind =
        view.note === 'settings-stale' ? 'warning' : 'error';
    return (
        <section
            className={styles.card}
            aria-labelledby="settings-title"
            aria-busy={view.pending}
        >
            <h1 id="settings-title">{settingsCopy.title}</h1>
            <p className={styles.server} title={versionTitle(view.about)}>
                {versionText(view.about)}
            </p>
            {view.about === null && view.pending && (
                <StatusMessage kind="loading">Loading settings…</StatusMessage>
            )}
            {view.about !== null && (
                <section aria-labelledby="settings-about-title">
                    <h2 id="settings-about-title">{settingsCopy.about}</h2>
                    <p>
                        {settingsCopy.hostname}:{' '}
                        <span className={styles.server}>
                            {view.about.hostname}
                        </span>
                    </p>
                    {view.about.buildSource !== '' && (
                        <p>
                            {settingsCopy.buildSource}:{' '}
                            <span className={styles.server}>
                                {view.about.buildSource}
                            </span>
                        </p>
                    )}
                    <p>
                        {settingsCopy.workspaces}:{' '}
                        <span className={styles.server}>
                            {view.about.workspaces}
                        </span>
                    </p>
                </section>
            )}
            <fieldset disabled={!view.ready} className={settings.group}>
                <legend className={settings.legend}>
                    {settingsCopy.behavior}
                </legend>
                <p>
                    {checkbox(
                        'hidden',
                        controls.hidden,
                        settingsCopy.toggles.hidden,
                    )}
                </p>
                <p>
                    <label className={settings.check}>
                        <input
                            type="checkbox"
                            checked={controls.reuse}
                            disabled={controls.reuseDisabled}
                            onChange={(event) =>
                                onToggle('reuse', event.target.checked)
                            }
                        />{' '}
                        {settingsCopy.toggles.reuse}
                    </label>
                </p>
                <p>
                    {checkbox(
                        'autoReconnect',
                        controls.autoReconnect,
                        settingsCopy.toggles.autoReconnect,
                    )}
                </p>
                <p>
                    <label className={settings.check}>
                        <input
                            type="checkbox"
                            checked={controls.lowPower}
                            onChange={(event) =>
                                onLowPower(event.target.checked)
                            }
                        />{' '}
                        {settingsCopy.toggles.lowPower}
                    </label>
                </p>
                <p>
                    {checkbox(
                        'piOffline',
                        controls.piOffline,
                        settingsCopy.toggles.piOffline,
                    )}
                </p>
                <p>
                    {checkbox(
                        'piBridgeNoInject',
                        controls.piBridgeNoInject,
                        settingsCopy.toggles.piBridgeNoInject,
                    )}
                </p>
                <p>
                    {checkbox(
                        'claudeSkip',
                        controls.claudeSkip,
                        settingsCopy.toggles.claudeSkip,
                    )}
                </p>
                <p>
                    {checkbox(
                        'agyTheme',
                        controls.agyTheme,
                        settingsCopy.toggles.agyTheme,
                    )}
                </p>
                <p>
                    <label>
                        {settingsCopy.toggles.idle}{' '}
                        <select
                            id="settings-opencode-idle"
                            name="opencode-idle-stop"
                            value={
                                settingsCopy.idleOptions.some(
                                    (option) =>
                                        option.value ===
                                        String(controls.idleMinutes),
                                )
                                    ? String(controls.idleMinutes)
                                    : '0'
                            }
                            onChange={(event) =>
                                onIdleMinutes(
                                    Number.parseInt(event.target.value, 10),
                                )
                            }
                        >
                            {settingsCopy.idleOptions.map((option) => (
                                <option key={option.value} value={option.value}>
                                    {option.label}
                                </option>
                            ))}
                        </select>
                    </label>
                </p>
                <p>{settingsCopy.idleHint}</p>
            </fieldset>
            {view.note !== null && (
                <StatusMessage kind={noteKind}>
                    {settingsCopy.messages[view.note]}
                </StatusMessage>
            )}
            <Button
                variant="accent"
                busy={view.pending}
                onClick={() => {
                    if (!view.pending) onRetry();
                }}
            >
                {view.pending ? 'Loading…' : settingsCopy.retry}
            </Button>
        </section>
    );
}
