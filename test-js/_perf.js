export function readSwitchPhases() {
    return performance
        .getEntriesByType('measure')
        .filter((entry) => entry.name.startsWith('phi:switch-'))
        .map((entry) => ({
            name: entry.name,
            ms: entry.duration,
        }));
}

export function reportSwitchPhases(label) {
    const phases = readSwitchPhases();
    const values = phases
        .map(({ name, ms }) => `${name}=${ms.toFixed(1)}ms`)
        .join(' ');
    const line = `[phi-perf] ${label} ${values || '(no switch measures)'}`;
    console.warn(line);
    return line;
}
