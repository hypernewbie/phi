import { useEffect, useState } from 'react';
import styles from './app.module.css';
import { Button } from './components/ui/Button.tsx';
import type { AuthSession } from './platform/auth-session.ts';
import {
    currentSearch,
    isDirectServe,
    navigateToLegacyMain,
    resolveLegacyHandoff,
} from './platform/legacy-handoff.ts';
import { ConnectionScreen } from './screens/ConnectionScreen.tsx';
import { LoginScreen } from './screens/LoginScreen.tsx';
import { SettingsScreen } from './screens/SettingsScreen.tsx';
import type { SettingsStore } from './platform/settings-store.ts';

type Screen = 'connection' | 'settings';

function SettingsPanel({ store }: { store: SettingsStore }) {
    const [view, setView] = useState(store.view);
    useEffect(() => store.start(setView), [store]);
    return (
        <SettingsScreen
            view={view}
            onRetry={store.retry}
            onToggle={store.setToggle}
            onIdleMinutes={store.setIdleMinutes}
            onLowPower={store.setLowPower}
        />
    );
}

export function App({
    session,
    settings,
}: {
    session: AuthSession;
    settings: SettingsStore;
}) {
    const [screen, setScreen] = useState<Screen>('connection');
    const [view, setView] = useState(session.view);
    useEffect(() => session.start(setView), [session]);
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
                    <Button
                        aria-current={
                            screen === 'connection' ? 'page' : undefined
                        }
                        onClick={() => setScreen('connection')}
                    >
                        Connection
                    </Button>
                    <Button
                        aria-current={
                            screen === 'settings' ? 'page' : undefined
                        }
                        disabled={view.phase !== 'ready'}
                        onClick={() => setScreen('settings')}
                    >
                        Settings
                    </Button>
                </nav>
            </header>
            <main className={styles.main}>
                {screen === 'settings' ? (
                    <SettingsPanel store={settings} />
                ) : view.phase === 'sign-in' ? (
                    <LoginScreen
                        view={view}
                        signIn={session.signIn}
                        onRetry={session.retry}
                    />
                ) : (
                    <ConnectionScreen view={view} onRetry={session.retry} />
                )}
            </main>
        </div>
    );
}
