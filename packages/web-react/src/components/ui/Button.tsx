import type { ComponentPropsWithRef } from 'react';
import styles from './button.module.css';

export type ButtonProps = ComponentPropsWithRef<'button'> & {
    variant?: 'primary' | 'accent';
    busy?: boolean;
};

export function Button({
    variant = 'primary',
    busy = false,
    disabled = false,
    type = 'button',
    className = '',
    ...props
}: ButtonProps) {
    return (
        <button
            {...props}
            type={type}
            className={`${styles.button} ${styles[variant]} ${className}`.trim()}
            disabled={disabled || busy}
            aria-busy={busy}
        />
    );
}
