import { useEffect, useRef, useState } from 'react';
import styles from '../app.module.css';
import { Button } from '../components/ui/Button.tsx';
import {
    StatusMessage,
    type StatusKind,
} from '../components/ui/StatusMessage.tsx';
import type { ConnectionResult, ConnectionService } from '../platform/http.ts';

type VisibleResult = Exclude<ConnectionResult, 'cancelled'> | 'loading';
const presentation: Record<VisibleResult, { kind: StatusKind; text: string }> =
    {
        loading: { kind: 'loading', text: 'Checking server…' },
        disabled: {
            kind: 'success',
            text: 'Connected. Password protection is disabled.',
        },
        protected: {
            kind: 'warning',
            text: 'Server requires sign-in. Login is not available in this stage.',
        },
        unsupported: {
            kind: 'warning',
            text: 'This server does not support v2 authentication.',
        },
        unavailable: {
            kind: 'error',
            text: 'Cannot check this server. Retry the connection.',
        },
    };

export function ConnectionScreen({ service }: { service: ConnectionService }) {
    const [result, setResult] = useState<VisibleResult>('loading');
    const [attempt, setAttempt] = useState(0);
    const generation = useRef(0);
    const retryButton = useRef<HTMLButtonElement>(null);
    const restoreRetryFocus = useRef(false);
    // biome-ignore lint/correctness/useExhaustiveDependencies: Each explicit retry must start a new request.
    useEffect(() => {
        const request = ++generation.current;
        const controller = new AbortController();
        setResult('loading');
        const accept = (next: ConnectionResult) => {
            if (
                request === generation.current &&
                !controller.signal.aborted &&
                next !== 'cancelled'
            )
                setResult(next);
        };
        void service
            .getStatus(controller.signal)
            .then(accept, () => accept('unavailable'));
        return () => {
            ++generation.current;
            controller.abort();
        };
    }, [service, attempt]);
    useEffect(() => {
        const button = retryButton.current;
        if (!button) return;
        const owner = button.ownerDocument;
        if (result !== 'loading') {
            // Native disable can blur Retry without the user moving focus.
            if (
                restoreRetryFocus.current &&
                owner.activeElement === owner.body &&
                owner.hasFocus()
            )
                button.focus({ preventScroll: true });
            restoreRetryFocus.current = false;
            return;
        }
        const cancel = () => {
            restoreRetryFocus.current = false;
        };
        const movedElsewhere = (event: Event) => {
            if (event.target !== button) cancel();
        };
        const tabbedAway = (event: KeyboardEvent) => {
            if (event.key === 'Tab') cancel();
        };
        owner.addEventListener('focusin', movedElsewhere);
        owner.addEventListener('pointerdown', movedElsewhere, true);
        owner.addEventListener('keydown', tabbedAway, true);
        owner.defaultView?.addEventListener('blur', cancel);
        return () => {
            owner.removeEventListener('focusin', movedElsewhere);
            owner.removeEventListener('pointerdown', movedElsewhere, true);
            owner.removeEventListener('keydown', tabbedAway, true);
            owner.defaultView?.removeEventListener('blur', cancel);
        };
    }, [result]);
    const { kind, text } = presentation[result];
    return (
        <section className={styles.card} aria-labelledby="connection-title">
            <h1 id="connection-title">Connection</h1>
            <p>Server</p>
            <p className={styles.server}>{service.serverLabel}</p>
            <StatusMessage kind={kind}>{text}</StatusMessage>
            <Button
                ref={retryButton}
                variant="accent"
                busy={result === 'loading'}
                onClick={(event) => {
                    restoreRetryFocus.current =
                        event.currentTarget.ownerDocument.activeElement ===
                        event.currentTarget;
                    setAttempt((value) => value + 1);
                }}
            >
                {result === 'loading' ? 'Checking…' : 'Retry'}
            </Button>
        </section>
    );
}
