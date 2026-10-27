import type { ReactNode } from 'react';
import styles from './status-message.module.css';

export type StatusKind = 'loading' | 'success' | 'warning' | 'error';

export function StatusMessage({
    kind,
    children,
}: {
    kind: StatusKind;
    children: ReactNode;
}) {
    return (
        <div
            className={`${styles.status} ${styles[kind]}`}
            role="status"
            aria-live="polite"
            aria-atomic="true"
        >
            {children}
        </div>
    );
}
