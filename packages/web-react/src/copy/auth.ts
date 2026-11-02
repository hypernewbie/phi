export type AuthMessageId =
    | 'wrong-password'
    | 'invalid-length'
    | 'sign-in-rejected'
    | 'rate-limited'
    | 'sign-in-unconfirmed'
    | 'status-unavailable'
    | 'unlock-failed'
    | 'separate-profile'
    | 'persistence-note'
    | 'read-stale';

export const authCopy = {
    title: 'Sign in to Phi',
    subtitle: 'Enter your password to continue.',
    submit: 'Sign in',
    submitting: 'Signing in…',
    blocked: 'This tab is bound to a different server. Reload the page.',
    messages: {
        'wrong-password': 'Wrong password',
        'invalid-length': 'Password must be 8 to 1024 bytes.',
        'sign-in-rejected': 'Sign-in request was rejected.',
        'rate-limited': 'Too many attempts. Wait and try again.',
        'sign-in-unconfirmed': 'Sign-in was not confirmed. Try again.',
        'status-unavailable': 'Cannot check this server. Retry the connection.',
        'unlock-failed': 'Unable to unlock Phi',
        'separate-profile': 'Use a separate browser profile for this server.',
        'persistence-note':
            'This browser blocks storage, so sign-in lasts for this visit only.',
        'read-stale': 'Showing the last known server. Retry to refresh.',
    } satisfies Record<AuthMessageId, string>,
};
