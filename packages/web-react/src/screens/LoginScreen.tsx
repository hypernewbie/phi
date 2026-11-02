import { useEffect, useRef, useState } from 'react';
import styles from '../app.module.css';
import { authCopy, type AuthMessageId } from '../copy/auth.ts';
import { Button } from '../components/ui/Button.tsx';
import type { AuthView, SignInOutcome } from '../platform/auth-session.ts';
import login from './login.module.css';

const outcomeMessage: Record<SignInOutcome, AuthMessageId | null> = {
    accepted: null,
    'invalid-length': 'invalid-length',
    'wrong-password': 'wrong-password',
    'rate-limited': 'rate-limited',
    rejected: 'sign-in-rejected',
    unconfirmed: 'sign-in-unconfirmed',
    cancelled: null,
};

export function LoginScreen({
    view,
    signIn,
    onRetry,
}: {
    view: AuthView;
    signIn: (password: string) => Promise<SignInOutcome>;
    onRetry: () => void;
}) {
    const [field, setField] = useState('');
    const [error, setError] = useState<AuthMessageId | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const input = useRef<HTMLInputElement>(null);
    useEffect(() => {
        input.current?.focus({ preventScroll: true });
    }, []);
    const revision = useRef(0);
    const errorRevision = useRef(-1);
    const shown =
        error !== null && errorRevision.current === revision.current
            ? error
            : view.message;
    return (
        <section className={styles.card} aria-labelledby="login-title">
            <h1 id="login-title">{authCopy.title}</h1>
            <p className={login.subtitle}>{authCopy.subtitle}</p>
            <p>Server</p>
            <p className={styles.server}>{view.serverLabel}</p>
            <form
                className={login.form}
                noValidate
                onSubmit={(event) => {
                    event.preventDefault();
                    if (submitting || !view.canSignIn) return;
                    const submitted = revision.current;
                    setSubmitting(true);
                    setError(null);
                    void signIn(field).then(
                        (outcome) => {
                            setSubmitting(false);
                            if (outcome === 'accepted') {
                                setField('');
                                revision.current += 1;
                                setError(null);
                                return;
                            }
                            if (submitted !== revision.current) return;
                            errorRevision.current = submitted;
                            setError(outcomeMessage[outcome]);
                        },
                        () => {
                            setSubmitting(false);
                            if (submitted !== revision.current) return;
                            errorRevision.current = submitted;
                            setError('sign-in-unconfirmed');
                        },
                    );
                }}
            >
                <label htmlFor="login-password">Password</label>
                <input
                    id="login-password"
                    ref={input}
                    className={login.field}
                    type="password"
                    autoComplete="current-password"
                    value={field}
                    aria-describedby={
                        shown === null ? 'login-help' : 'login-help login-error'
                    }
                    onChange={(event) => {
                        revision.current += 1;
                        setField(event.target.value);
                    }}
                />
                <p id="login-help" className={login.help}>
                    8 to 1024 bytes. The password stays in this form until it is
                    accepted.
                </p>
                <div
                    id="login-error"
                    className={login.error}
                    role={shown === null ? undefined : 'alert'}
                >
                    {shown === null ? '' : authCopy.messages[shown]}
                </div>
                <Button
                    type="submit"
                    variant="accent"
                    busy={submitting}
                    disabled={!view.canSignIn}
                >
                    {submitting ? authCopy.submitting : authCopy.submit}
                </Button>
            </form>
            {!view.canSignIn && !submitting && (
                <Button onClick={onRetry}>Retry</Button>
            )}
        </section>
    );
}
