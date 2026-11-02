import { useEffect, useRef } from 'react';
import styles from '../app.module.css';
import { authCopy } from '../copy/auth.ts';
import { Button } from '../components/ui/Button.tsx';
import {
    StatusMessage,
    type StatusKind,
} from '../components/ui/StatusMessage.tsx';
import type { AuthView } from '../platform/auth-session.ts';

export function ConnectionScreen({
    view,
    onRetry,
}: {
    view: AuthView;
    onRetry: () => void;
}) {
    const retryButton = useRef<HTMLButtonElement>(null);
    const restoreRetryFocus = useRef(false);
    const pending = view.pending;
    useEffect(() => {
        const button = retryButton.current;
        if (!button) return;
        const owner = button.ownerDocument;
        if (!pending) {
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
    }, [pending]);
    const status = statusFor(view);
    return (
        <section className={styles.card} aria-labelledby="connection-title">
            <h1 id="connection-title">Connection</h1>
            <p>Server</p>
            <p className={styles.server}>{view.serverLabel}</p>
            {view.hostname !== null && (
                <p>
                    {view.stale ? 'Last known server' : 'Server name'}:{' '}
                    <span className={styles.server}>{view.hostname}</span>
                </p>
            )}
            <StatusMessage kind={status.kind}>{status.text}</StatusMessage>
            {view.message !== null &&
                view.phase === 'ready' &&
                status.text !== authCopy.messages[view.message] && (
                    <p>{authCopy.messages[view.message]}</p>
                )}
            <Button
                ref={retryButton}
                variant="accent"
                busy={pending}
                onClick={(event) => {
                    restoreRetryFocus.current =
                        event.currentTarget.ownerDocument.activeElement ===
                        event.currentTarget;
                    onRetry();
                }}
            >
                {pending ? 'Checking…' : 'Retry'}
            </Button>
        </section>
    );
}

function statusFor(view: AuthView): { kind: StatusKind; text: string } {
    switch (view.phase) {
        case 'checking':
            return { kind: 'loading', text: 'Checking server…' };
        case 'unsupported':
            return {
                kind: 'warning',
                text: 'This server does not support v2 authentication.',
            };
        case 'blocked':
            return { kind: 'error', text: authCopy.blocked };
        case 'unavailable':
            return {
                kind: 'error',
                text:
                    view.message === null
                        ? 'Cannot check this server. Retry the connection.'
                        : authCopy.messages[view.message],
            };
        case 'ready':
            if (view.pending && view.hostname === null)
                return { kind: 'loading', text: 'Reading server…' };
            return view.protection === 'disabled'
                ? {
                      kind: 'success',
                      text: 'Connected. Password protection is disabled.',
                  }
                : { kind: 'success', text: 'Connected.' };
        case 'sign-in':
            return { kind: 'loading', text: 'Checking server…' };
    }
}
