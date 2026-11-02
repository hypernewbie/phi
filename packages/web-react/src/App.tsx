import { useEffect, useState } from 'react';
import styles from './app.module.css';
import { Button } from './components/ui/Button.tsx';
import type { AuthSession } from './platform/auth-session.ts';
import { ConnectionScreen } from './screens/ConnectionScreen.tsx';
import { LoginScreen } from './screens/LoginScreen.tsx';

type Screen = 'connection';

export function App({ session }: { session: AuthSession }) {
    const [screen, setScreen] = useState<Screen>('connection');
    const [view, setView] = useState(session.view);
    useEffect(() => session.start(setView), [session]);
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
                </nav>
            </header>
            <main className={styles.main}>
                {screen === 'connection' &&
                    (view.phase === 'sign-in' ? (
                        <LoginScreen
                            view={view}
                            signIn={session.signIn}
                            onRetry={session.retry}
                        />
                    ) : (
                        <ConnectionScreen view={view} onRetry={session.retry} />
                    ))}
            </main>
        </div>
    );
}
