import { useState } from 'react';
import styles from './app.module.css';
import { Button } from './components/ui/Button.tsx';
import type { ConnectionService } from './platform/http.ts';
import { ConnectionScreen } from './screens/ConnectionScreen.tsx';

type Screen = 'connection';

export function App({ service }: { service: ConnectionService }) {
    const [screen, setScreen] = useState<Screen>('connection');
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
                {screen === 'connection' && (
                    <ConnectionScreen service={service} />
                )}
            </main>
        </div>
    );
}
