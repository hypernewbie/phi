import { useEffect, useRef, useState } from 'react';
import styles from './app.module.css';
import { Button } from './components/ui/Button.tsx';
import { Modal } from './components/ui/Modal.tsx';
import type { AuthSession } from './platform/auth-session.ts';
import { settingsCopy } from './copy/settings.ts';
import {
    currentSearch,
    isDirectServe,
    navigateToLegacyMain,
    resolveLegacyHandoff,
} from './platform/legacy-handoff.ts';
import { isVisible } from './platform/modal-trap.ts';
import {
    closePopout,
    defaultPopoutDeps,
    isPopoutCloseNow,
    tryOpenNative,
} from './platform/native-popout.ts';
import { ConnectionScreen } from './screens/ConnectionScreen.tsx';
import { LoginScreen } from './screens/LoginScreen.tsx';
import { SettingsScreen } from './screens/SettingsScreen.tsx';
import type { SettingsStore } from './platform/settings-store.ts';
import type { MobileAppearanceStore } from './platform/mobile-appearance-store.ts';

function SettingsPanel({
    store,
    mobile,
    onMobileSignIn,
}: {
    store: SettingsStore;
    mobile: MobileAppearanceStore | null;
    onMobileSignIn: () => void;
}) {
    const [view, setView] = useState(store.view);
    // The mobile store is app-lifetime like legacy: closing the modal
    // drops the subscription, never the store.
    useEffect(() => {
        const stop = store.start(setView);
        void mobile?.start();
        return () => {
            stop();
        };
    }, [store, mobile]);
    return (
        <SettingsScreen
            view={view}
            onRetry={store.retry}
            onToggle={store.setToggle}
            onIdleMinutes={store.setIdleMinutes}
            onLowPower={store.setLowPower}
            onHostname={store.setHostnameOverride}
            onUIFontFamily={store.setUIFontFamily}
            onUIFontSize={store.setUIFontSize}
            onTerminalFontFamily={store.setTerminalFontFamily}
            onTerminalFontSize={store.setTerminalFontSize}
            onMobileScrollback={store.setMobileScrollback}
            onThemeColor={store.setThemeColor}
            onProfile={store.setProfile}
            onResetAppearance={store.resetAppearance}
            onSetAccessPassword={store.setAccessPassword}
            onClearAccessPassword={store.clearAccessPassword}
            onSecurityEdit={store.dismissSecurity}
            onUploadFont={store.uploadFont}
            onUploadBackground={store.uploadBackground}
            onRemoveBackground={store.removeBackground}
            mobileStore={mobile}
            onMobileSignIn={onMobileSignIn}
        />
    );
}

export function App({
    session,
    settings,
    mobile,
}: {
    session: AuthSession;
    settings: SettingsStore;
    mobile: MobileAppearanceStore | null;
}) {
    // A claimed popout renders settings immediately; closing it
    // closes the popup instead of unmounting the modal.
    const [settingsOpen, setSettingsOpen] = useState(isPopoutCloseNow);
    const closeSettings = (): void => {
        if (isPopoutCloseNow()) closePopout(defaultPopoutDeps());
        else setSettingsOpen(false);
    };
    const [view, setView] = useState(session.view);
    const openerRef = useRef<HTMLButtonElement | null>(null);
    useEffect(() => session.start(setView), [session]);
    useEffect(() => {
        if (settingsOpen || openerRef.current === null) return;
        const opener = openerRef.current;
        openerRef.current = null;
        if (isVisible(opener)) opener.focus();
    }, [settingsOpen]);
    useEffect(() => {
        if (resolveLegacyHandoff(isDirectServe(), view.phase, currentSearch()))
            navigateToLegacyMain();
    }, [view.phase]);
    return (
        <div className={styles.shell}>
            <header className={styles.header}>
                <div className={styles.brand}>
                    <span className={styles.logo} aria-hidden="true">
                        Φ
                    </span>
                    <span>phi</span>
                </div>
                <nav aria-label="Main" className={styles.navigation}>
                    <Button aria-current="page">Connection</Button>
                    <Button
                        disabled={view.phase !== 'ready'}
                        onClick={(event) => {
                            if (
                                tryOpenNative(
                                    'desktop',
                                    defaultPopoutDeps(),
                                )
                            )
                                return;
                            openerRef.current = event.currentTarget;
                            setSettingsOpen(true);
                        }}
                    >
                        Settings
                    </Button>
                </nav>
            </header>
            <main className={styles.main}>
                {view.phase === 'sign-in' ? (
                    <LoginScreen
                        view={view}
                        signIn={session.signIn}
                        onRetry={session.retry}
                    />
                ) : (
                    <ConnectionScreen view={view} onRetry={session.retry} />
                )}
            </main>
            {settingsOpen && (
                <Modal
                    label="Phi Settings"
                    doneLabel={settingsCopy.done}
                    closeLabel={settingsCopy.closeLabel}
                    onClose={closeSettings}
                >
                    <SettingsPanel
                        store={settings}
                        mobile={mobile}
                        onMobileSignIn={() => {
                            session.retry();
                            void mobile?.refresh(true);
                        }}
                    />
                </Modal>
            )}
        </div>
    );
}
