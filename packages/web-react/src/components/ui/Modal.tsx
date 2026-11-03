import { useEffect, useRef, type ReactNode } from 'react';
import { trapModal } from '../../platform/modal-trap.ts';
import { Button } from './Button.tsx';
import styles from './modal.module.css';

export function Modal({
    label,
    doneLabel,
    closeLabel,
    onClose,
    children,
}: {
    label: string;
    doneLabel: string;
    closeLabel: string;
    onClose: () => void;
    children: ReactNode;
}) {
    const modalRef = useRef<HTMLDivElement>(null);
    const closeRef = useRef<HTMLButtonElement>(null);
    useEffect(
        () =>
            modalRef.current
                ? trapModal(
                      modalRef.current,
                      closeRef.current ?? modalRef.current,
                      onClose,
                  )
                : undefined,
        [onClose],
    );
    return (
        // biome-ignore lint/a11y/noStaticElementInteractions: overlay click is a pointer-only shortcut; keyboard users close via the close button, Done, or Escape
        // biome-ignore lint/a11y/useKeyWithClickEvents: overlay click is a pointer-only shortcut; keyboard users close via the close button, Done, or Escape
        <div
            className={styles.overlay}
            onClick={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <div
                ref={modalRef}
                role="dialog"
                aria-modal="true"
                aria-label={label}
                tabIndex={-1}
                className={styles.modal}
            >
                <div className={styles.header}>
                    <button
                        ref={closeRef}
                        type="button"
                        title={closeLabel}
                        aria-label={closeLabel}
                        className={styles.close}
                        onClick={onClose}
                    >
                        ×
                    </button>
                </div>
                {children}
                <div className={styles.footer}>
                    <Button variant="accent" onClick={onClose}>
                        {doneLabel}
                    </Button>
                </div>
            </div>
        </div>
    );
}
