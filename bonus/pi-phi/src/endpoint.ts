// Local IPC target validation. Mirrors internal/pibridge/validate.go.
// Accepts only server-generated shapes; rejects TCP, authorities,
// credentials, relative paths, NUL, and percent encoding.

export type IpcTargetKind = 'unix' | 'windows-pipe';

/**
 * A target that can never become valid (wrong scheme, remote address,
 * relative path). The runtime stops retrying on this error instead of
 * reconnecting to a bad address forever.
 */
export class InvalidTargetError extends Error {}

export interface ParsedTarget {
    kind: IpcTargetKind;
    /** Literal address after the "unix:" prefix. Spaces survive unchanged. */
    path: string;
}

const PIPE_PREFIX = String.raw`\\.\pipe\phi-pi-`;

function isHex(s: string): boolean {
    return /^[0-9a-fA-F]+$/.test(s);
}

/** Parse and validate a dial target. Throws on any unsupported shape. */
export function parseTarget(target: string): ParsedTarget {
    const prefix = 'unix:';
    if (!target.startsWith(prefix)) {
        throw new InvalidTargetError('target must use unix: scheme');
    }
    const rest = target.slice(prefix.length);
    if (rest === '') throw new InvalidTargetError('target has no address');
    if (rest.includes('\0'))
        throw new InvalidTargetError('target contains NUL');
    if (rest.includes('%'))
        throw new InvalidTargetError('target must not use percent encoding');
    if (rest.includes('@'))
        throw new InvalidTargetError('target must not carry credentials');
    if (rest.includes('://'))
        throw new InvalidTargetError('target must not carry an authority');

    if (rest.startsWith(PIPE_PREFIX)) {
        const name = rest.slice(PIPE_PREFIX.length);
        if (name.length < 32)
            throw new InvalidTargetError('pipe name too short');
        if (!isHex(name)) throw new InvalidTargetError('pipe name must be hex');
        return { kind: 'windows-pipe', path: rest };
    }
    if (rest.startsWith(String.raw`\\`)) {
        throw new InvalidTargetError('remote pipe hosts are rejected');
    }
    if (!rest.startsWith('/')) {
        throw new InvalidTargetError('unix socket path must be absolute');
    }
    if (rest.startsWith('//')) {
        throw new InvalidTargetError('target must not carry an authority');
    }
    return { kind: 'unix', path: rest };
}
