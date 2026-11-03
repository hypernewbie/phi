import { useState, type CSSProperties } from 'react';
import styles from '../app.module.css';
import { Button } from '../components/ui/Button.tsx';
import settings from './settings.module.css';
import {
    StatusMessage,
    type StatusKind,
} from '../components/ui/StatusMessage.tsx';
import {
    CUSTOM_FONT_VALUE,
    PROFILE_OPTIONS,
    PROFILE_ROW,
    SCROLLBACK_ROW,
    TERM_FONT_OPTIONS,
    TERM_FONT_ROW,
    TERM_SIZE_ROW,
    UI_FONT_OPTIONS,
    UI_FONT_ROW,
    UI_SIZE_ROW,
    appearanceCopy,
    currentFontLabel,
    customFontLabel,
    type FontOption,
} from '../copy/appearance.ts';
import { settingsCopy } from '../copy/settings.ts';
import { ACCENT_COLORS } from '../platform/accent-theme.ts';
import type {
    AppearanceControls,
    SettingsView,
    ToggleKey,
} from '../platform/settings-store.ts';
import {
    currentProfile,
    type ProfileOverride,
} from '../platform/appearance-scope.ts';
import type { MobileAppearanceStore } from '../platform/mobile-appearance-store.ts';
import { MobileAppearance } from './MobileAppearance.tsx';

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

// Number rows keep a text draft so out-of-range keystrokes stay visible
// while the store ignores them, like the legacy uncontrolled inputs.
// Any committed change (own, reset, or external) clears the draft.
function NumberRow({
    id,
    label,
    min,
    max,
    fallback,
    committed,
    onCommit,
}: {
    id: string;
    label: string;
    min: number;
    max: number;
    fallback: number;
    committed: number;
    onCommit: (raw: string) => void;
}) {
    const [draft, setDraft] = useState<string | null>(null);
    const [lastCommitted, setLastCommitted] = useState(committed);
    if (lastCommitted !== committed) {
        setLastCommitted(committed);
        setDraft(null);
    }
    return (
        <p>
            <label>
                {label}{' '}
                <input
                    type="number"
                    id={id}
                    name={id}
                    min={min}
                    max={max}
                    value={draft ?? String(committed || fallback)}
                    onChange={(event) => {
                        setDraft(event.target.value);
                        onCommit(event.target.value);
                    }}
                />
            </label>
        </p>
    );
}

function withCustomFont(
    options: ReadonlyArray<FontOption>,
    customName: string,
): Array<FontOption> {
    if (customName === '') return [...options];
    return [
        ...options,
        { value: CUSTOM_FONT_VALUE, label: customFontLabel(customName) },
    ];
}

// Access-password inputs are screen-owned drafts: typing dismisses the
// store error, and a done flip clears both fields (legacy parity).
function SecuritySection({
    security,
    ready,
    onSetAccessPassword,
    onClearAccessPassword,
    onSecurityEdit,
}: {
    security: SettingsView['security'];
    ready: boolean;
    onSetAccessPassword: (next: string, confirm: string) => void;
    onClearAccessPassword: () => void;
    onSecurityEdit: () => void;
}) {
    const copy = settingsCopy.security;
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [confirmingRemove, setConfirmingRemove] = useState(false);
    const [lastDone, setLastDone] = useState(security.done);
    if (security.done !== lastDone) {
        setLastDone(security.done);
        if (security.done !== null) {
            setNewPassword('');
            setConfirmPassword('');
            setConfirmingRemove(false);
        }
    }
    const edit =
        (set: (value: string) => void) =>
        (event: React.ChangeEvent<HTMLInputElement>) => {
            set(event.target.value);
            onSecurityEdit();
        };
    return (
        <fieldset disabled={!ready} className={settings.group}>
            <legend className={settings.legend}>{copy.title}</legend>
            <p className={settings.securityHeader}>
                <span>{copy.accessPassword}</span>
                <span
                    aria-hidden="true"
                    className={`${settings.accessDot} ${security.enabled ? settings.isOn : settings.isOff}`}
                />
                <span>
                    {security.enabled ? copy.enabledText : copy.disabledText}
                </span>
            </p>
            <p>
                <input
                    type="password"
                    id={copy.newId}
                    name="new-password"
                    autoComplete="new-password"
                    placeholder={copy.newPlaceholder}
                    aria-label={copy.newPlaceholder}
                    value={newPassword}
                    disabled={security.busy}
                    className={
                        security.error === null ? undefined : settings.isInvalid
                    }
                    onChange={edit(setNewPassword)}
                />
            </p>
            <p>
                <input
                    type="password"
                    id={copy.confirmId}
                    name="confirm-password"
                    autoComplete="new-password"
                    placeholder={copy.confirmPlaceholder}
                    aria-label={copy.confirmPlaceholder}
                    value={confirmPassword}
                    disabled={security.busy}
                    className={
                        security.error === null ? undefined : settings.isInvalid
                    }
                    onChange={edit(setConfirmPassword)}
                />
            </p>
            <p className={settings.securityHintRow}>
                <span className={settings.hint}>{copy.hint}</span>
                {security.error !== null && (
                    <span role="alert" className={settings.accessError}>
                        {copy.errors[security.error]}
                    </span>
                )}
            </p>
            <p className={settings.securityActionsRow}>
                <Button
                    variant="accent"
                    busy={security.busy}
                    className={settings.securityPrimary}
                    onClick={() =>
                        onSetAccessPassword(newPassword, confirmPassword)
                    }
                >
                    {security.enabled ? copy.updateButton : copy.setButton}
                </Button>
                {security.enabled && !confirmingRemove && (
                    <button
                        type="button"
                        className={settings.removeLink}
                        onClick={() => setConfirmingRemove(true)}
                    >
                        {copy.removeLink}
                    </button>
                )}
                {security.enabled && confirmingRemove && (
                    <Button
                        busy={security.busy}
                        className={settings.securityPrimary}
                        onClick={onClearAccessPassword}
                    >
                        {copy.confirmRemove}
                    </Button>
                )}
            </p>
            {security.done !== null && (
                <p role="status" className={settings.hint}>
                    {copy.done[security.done]}
                </p>
            )}
        </fieldset>
    );
}

export function SettingsScreen({
    view,
    onRetry,
    onToggle,
    onIdleMinutes,
    onLowPower,
    onHostname,
    onUIFontFamily,
    onUIFontSize,
    onTerminalFontFamily,
    onTerminalFontSize,
    onMobileScrollback,
    onThemeColor,
    onProfile,
    onResetAppearance,
    onSetAccessPassword,
    onClearAccessPassword,
    onSecurityEdit,
    mobileStore,
    onMobileSignIn,
}: {
    view: SettingsView;
    onRetry: () => void;
    onToggle: (key: ToggleKey, checked: boolean) => void;
    onIdleMinutes: (minutes: number) => void;
    onLowPower: (enabled: boolean) => void;
    onHostname: (text: string) => void;
    onUIFontFamily: (family: string) => void;
    onUIFontSize: (raw: string) => void;
    onTerminalFontFamily: (family: string) => void;
    onTerminalFontSize: (raw: string) => void;
    onMobileScrollback: (raw: string) => void;
    onThemeColor: (color: string) => void;
    onProfile: (profile: ProfileOverride) => void;
    onResetAppearance: () => void;
    onSetAccessPassword: (next: string, confirm: string) => void;
    onClearAccessPassword: () => void;
    onSecurityEdit: () => void;
    mobileStore: MobileAppearanceStore | null;
    onMobileSignIn: () => void;
}) {
    const controls = view.controls;
    const appearance: AppearanceControls = view.appearance;
    // Legacy forces the mobile page whenever the effective profile is
    // mobile; the override alone decides in tests and desktop browsers.
    const forcedMobile =
        appearance.profile === 'mobile' ||
        (appearance.profile === 'auto' && currentProfile() === 'mobile');
    const [selected, setSelected] = useState<'desktop' | 'mobile'>(() =>
        forcedMobile ? 'mobile' : 'desktop',
    );
    const page = forcedMobile ? 'mobile' : selected;
    const scrollbackRow = (
        <NumberRow
            id={SCROLLBACK_ROW.id}
            label={SCROLLBACK_ROW.label}
            min={SCROLLBACK_ROW.min}
            max={SCROLLBACK_ROW.max}
            fallback={SCROLLBACK_ROW.displayDefault}
            committed={appearance.mobileScrollbackRows}
            onCommit={onMobileScrollback}
        />
    );
    const uiOptions = withCustomFont(
        UI_FONT_OPTIONS,
        appearance.customFontName,
    );
    const termOptions = withCustomFont(
        TERM_FONT_OPTIONS,
        appearance.customFontName,
    );
    if (
        appearance.terminalFontFamily !== '' &&
        appearance.terminalFontFamily !== CUSTOM_FONT_VALUE &&
        !termOptions.some(
            (option) => option.value === appearance.terminalFontFamily,
        )
    )
        termOptions.splice(1, 0, {
            value: appearance.terminalFontFamily,
            label: currentFontLabel(appearance.terminalFontFamily),
        });
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
            <p className={settings.pageSwitch}>
                {!forcedMobile && (
                    <Button
                        id="settings-desktop-view"
                        variant={page === 'desktop' ? 'accent' : 'primary'}
                        aria-pressed={page === 'desktop'}
                        onClick={() => setSelected('desktop')}
                    >
                        Settings
                    </Button>
                )}
                <Button
                    id="settings-mobile-view"
                    variant={page === 'mobile' ? 'accent' : 'primary'}
                    aria-pressed={page === 'mobile'}
                    onClick={() => {
                        setSelected('mobile');
                        void mobileStore?.refresh();
                    }}
                >
                    Mobile Settings
                </Button>
            </p>
            <fieldset disabled={!view.ready} className={settings.group}>
                <legend className={settings.legend}>
                    {appearanceCopy.thisBrowser}
                </legend>
                <p>
                    <label>
                        {PROFILE_ROW.label}{' '}
                        <select
                            id={PROFILE_ROW.id}
                            name={PROFILE_ROW.id}
                            value={appearance.profile}
                            disabled={appearance.profileNative}
                            onChange={(event) =>
                                onProfile(event.target.value as ProfileOverride)
                            }
                        >
                            {PROFILE_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>
                                    {option.label}
                                </option>
                            ))}
                        </select>
                    </label>
                </p>
                {appearance.profileNative && (
                    <p className={settings.hint}>
                        {appearanceCopy.nativeProfileWarning}
                    </p>
                )}
                {appearance.profileMemoryOnly && (
                    <p className={settings.hint}>
                        {appearanceCopy.memoryOnlyProfileWarning}
                    </p>
                )}
            </fieldset>
            {page === 'mobile' && (
                <>
                    <MobileAppearance
                        store={mobileStore}
                        uiOptions={uiOptions}
                        termOptions={termOptions}
                        customFontName={appearance.customFontName}
                        onSignIn={onMobileSignIn}
                    />
                    {scrollbackRow}
                </>
            )}
            <fieldset disabled={!view.ready} className={settings.group}>
                <legend className={settings.legend}>
                    {page === 'mobile'
                        ? 'Shared appearance'
                        : appearanceCopy.appearance}
                </legend>
                <div className={settings.swatchRow}>
                    <span>{appearanceCopy.highlightColor}</span>
                    <div
                        role="radiogroup"
                        aria-label={appearanceCopy.highlightColor}
                        className={settings.swatchGrid}
                    >
                        {Object.entries(ACCENT_COLORS).map(([key, theme]) => (
                            <input
                                key={key}
                                type="radio"
                                name="highlight-color"
                                value={key}
                                checked={key === appearance.themeColor}
                                title={key}
                                style={
                                    {
                                        '--swatch': theme.accent,
                                    } as CSSProperties
                                }
                                className={settings.swatch}
                                onChange={() => onThemeColor(key)}
                            />
                        ))}
                    </div>
                </div>
                {page === 'desktop' && (
                    <>
                        <p>
                            <label>
                                {UI_FONT_ROW.label}{' '}
                                <select
                                    id={UI_FONT_ROW.id}
                                    name={UI_FONT_ROW.id}
                                    value={
                                        uiOptions.some(
                                            (option) =>
                                                option.value ===
                                                appearance.uiFontFamily,
                                        )
                                            ? appearance.uiFontFamily
                                            : ''
                                    }
                                    onChange={(event) =>
                                        onUIFontFamily(event.target.value)
                                    }
                                >
                                    {uiOptions.map((option) => (
                                        <option
                                            key={option.value}
                                            value={option.value}
                                        >
                                            {option.label}
                                        </option>
                                    ))}
                                </select>
                            </label>
                        </p>
                        <NumberRow
                            id={UI_SIZE_ROW.id}
                            label={UI_SIZE_ROW.label}
                            min={UI_SIZE_ROW.min}
                            max={UI_SIZE_ROW.max}
                            fallback={UI_SIZE_ROW.displayDefault}
                            committed={appearance.uiFontSize}
                            onCommit={onUIFontSize}
                        />
                        <p>
                            <label>
                                {TERM_FONT_ROW.label}{' '}
                                <select
                                    id={TERM_FONT_ROW.id}
                                    name={TERM_FONT_ROW.id}
                                    value={appearance.terminalFontFamily}
                                    onChange={(event) =>
                                        onTerminalFontFamily(event.target.value)
                                    }
                                >
                                    {termOptions.map((option) => (
                                        <option
                                            key={option.value}
                                            value={option.value}
                                        >
                                            {option.label}
                                        </option>
                                    ))}
                                </select>
                            </label>
                        </p>
                        <NumberRow
                            id={TERM_SIZE_ROW.id}
                            label={TERM_SIZE_ROW.label}
                            min={TERM_SIZE_ROW.min}
                            max={TERM_SIZE_ROW.max}
                            fallback={TERM_SIZE_ROW.displayDefault}
                            committed={appearance.terminalFontSize}
                            onCommit={onTerminalFontSize}
                        />
                        <p>
                            <Button onClick={onResetAppearance}>
                                {appearanceCopy.resetAppearance}
                            </Button>
                        </p>
                    </>
                )}
                {page === 'desktop' && scrollbackRow}
            </fieldset>
            <fieldset disabled={!view.ready} className={settings.group}>
                <legend className={settings.legend}>
                    {settingsCopy.behavior}
                </legend>
                <p>
                    <label title={settingsCopy.hostnameTitle}>
                        {settingsCopy.hostnameLabel}{' '}
                        <input
                            type="text"
                            id="settings-hostname-override"
                            name="hostname"
                            value={controls.hostnameOverride}
                            placeholder={settingsCopy.hostnamePlaceholder}
                            autoComplete="off"
                            spellCheck={false}
                            onChange={(event) => onHostname(event.target.value)}
                        />
                    </label>
                </p>
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
            <SecuritySection
                security={view.security}
                ready={view.ready}
                onSetAccessPassword={onSetAccessPassword}
                onClearAccessPassword={onClearAccessPassword}
                onSecurityEdit={onSecurityEdit}
            />
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
