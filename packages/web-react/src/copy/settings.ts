export type SettingsMessageId = 'settings-unavailable' | 'settings-stale';

export const settingsCopy = {
    title: 'Settings',
    about: 'About',
    behavior: 'Behavior',
    hostname: 'Hostname',
    buildSource: 'Build source',
    workspaces: 'Workspaces',
    retry: 'Retry',
    done: 'Close',
    closeLabel: 'Close',
    unknownBuild: 'unknown build',
    hostnameLabel: 'Hostname label (blank = real hostname)',
    hostnameTitle:
        "A display label for this machine in phi's UI, push titles, and status dumps. Purely cosmetic: it never affects how sockets connect, so it does not need to be a real hostname (any short text works).",
    hostnamePlaceholder: 'e.g. dusty_potato, europa, homelab',
    toggles: {
        hidden: 'Use separate hidden terminal for commands',
        reuse: 'Reuse shell tab for terminal commands',
        autoReconnect:
            'Auto-reconnect disconnected terminals (all tabs when visible)',
        lowPower: 'Low power mode (disable expensive visual effects)',
        piOffline: 'Start pi with --offline (new tabs only)',
        piBridgeNoInject:
            'Skip Phi bridge injection for pi (manual install, new tabs only)',
        claudeSkip:
            'Start Claude with --dangerously-skip-permissions (new tabs only)',
        agyTheme: 'Harmonise Agy terminal colours with active Phi theme',
        idle: 'Stop OpenCode server when idle',
    },
    idleOptions: [
        { value: '0', label: 'Off' },
        { value: '15', label: '15 min' },
        { value: '30', label: '30 min' },
        { value: '60', label: '1 hr' },
        { value: '120', label: '2 hr' },
        { value: '240', label: '4 hr' },
    ],
    idleHint:
        'Stops OpenCode\u2019s background server after no OpenCode activity in Phi. Assumes OpenCode is only used through Phi.',
    messages: {
        'settings-unavailable': 'Cannot load settings. Retry to refresh.',
        'settings-stale': 'Showing saved settings. Retry to refresh.',
    },
    security: {
        title: 'Security',
        accessPassword: 'Access password',
        enabledText: 'Enabled',
        disabledText: 'Disabled',
        newId: 'settings-access-new',
        confirmId: 'settings-access-confirm',
        newPlaceholder: 'New password',
        confirmPlaceholder: 'Confirm new password',
        hint: '8+ characters.',
        setButton: 'Set password',
        updateButton: 'Update password',
        removeLink: '\u00b7  Remove password',
        confirmRemove: 'Confirm remove',
        errors: {
            'too-short': 'At least 8 characters.',
            mismatch: 'Passwords don\u2019t match.',
            'too-long': 'Password must be at most 1024 bytes.',
            'sign-in': 'Sign in to change Phi access',
            'rate-limited': 'Too many attempts. Try again in a moment.',
            'save-failed': 'Unable to save access password',
            'clear-failed': 'Unable to clear access password',
        },
        done: {
            updated: 'Password updated',
            removed: 'Password removed',
        },
    },
};
