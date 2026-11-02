export type SettingsMessageId = 'settings-unavailable' | 'settings-stale';

export const settingsCopy = {
    title: 'Settings',
    about: 'About',
    behavior: 'Behavior',
    hostname: 'Hostname',
    buildSource: 'Build source',
    workspaces: 'Workspaces',
    retry: 'Retry',
    unknownBuild: 'unknown build',
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
};
