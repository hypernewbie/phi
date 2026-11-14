// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { __test__ } from '../web/auth.js';

const {
    validStatus,
    parseProtocols,
    parseAccessStatus,
    parseCredentialBundle,
} = __test__;

const v1 = (over = {}) => ({
    enabled: true,
    version: 'v1',
    algorithm: 'pbkdf2-sha256',
    iterations: 600_000,
    salt: 'c2FsdA',
    challenge: 'Y2hhbA',
    ...over,
});

const bundle = (over = {}) => ({
    token: 'token-1',
    expires_at: 1_800_000_000_000,
    expires_in: 3_600,
    refresh_idle_expires_at: 1_800_000_100_000,
    refresh_absolute_expires_at: 1_800_000_200_000,
    ...over,
});

describe('validStatus', () => {
    it('accepts the v1 KDF record', () => {
        expect(validStatus(v1())).toBe(true);
    });

    it('rejects anything that is not the v1 KDF record', () => {
        for (const status of [
            null,
            undefined,
            'v1',
            [],
            v1({ enabled: false }),
            v1({ enabled: 'true' }),
            v1({ version: 'v2' }),
            v1({ algorithm: 'sha256' }),
            v1({ iterations: 0 }),
            v1({ iterations: -1 }),
            v1({ iterations: 1.5 }),
            v1({ iterations: '600000' }),
            v1({ salt: 7 }),
            v1({ challenge: null }),
        ]) {
            expect(validStatus(status), JSON.stringify(status)).toBe(false);
        }
    });
});

describe('parseProtocols', () => {
    it('defaults an absent field to v1 only', () => {
        expect(parseProtocols(undefined)).toEqual(['v1']);
    });

    it('keeps the supported protocols in order and drops unknown names', () => {
        expect(parseProtocols(['v1'])).toEqual(['v1']);
        expect(parseProtocols(['v2'])).toEqual(['v2']);
        expect(parseProtocols(['v1', 'v2'])).toEqual(['v1', 'v2']);
        expect(parseProtocols(['v2', 'future'])).toEqual(['v2']);
        expect(parseProtocols(['future', 'v2', 'v1'])).toEqual(['v2', 'v1']);
    });

    const rejected = {
        null: null,
        empty: [],
        'a bare string': 'v2',
        'an empty name': [''],
        'a duplicate': ['v1', 'v1'],
        'a non-string': [1],
        'only unknown names': ['future'],
    };
    for (const [name, value] of Object.entries(rejected)) {
        it(`throws for ${name}`, () => {
            expect(() => parseProtocols(value)).toThrow(
                'Phi returned invalid access protection settings',
            );
        });
    }
});

describe('parseAccessStatus', () => {
    it('returns the enabled status and keeps the raw payload', () => {
        const payload = {
            enabled: true,
            authenticated: true,
            protocols: ['v2'],
            extra: 'kept',
        };
        const status = parseAccessStatus(payload);
        expect(status.enabled).toBe(true);
        expect(status.authenticated).toBe(true);
        expect(status.protocols).toEqual(['v2']);
        // v1 metadata is read from the original object later in the flow.
        expect(status.raw).toBe(payload);
    });

    it('defaults authenticated to false when access is disabled', () => {
        const status = parseAccessStatus({ enabled: false });
        expect(status.enabled).toBe(false);
        expect(status.authenticated).toBe(false);
        expect(status.protocols).toEqual(['v1']);
    });

    it('keeps authenticated false unless it is literally true', () => {
        expect(
            parseAccessStatus({ enabled: true, authenticated: false })
                .authenticated,
        ).toBe(false);
    });

    const rejected = {
        null: null,
        array: [],
        string: 'enabled',
        'a missing enabled': { authenticated: true },
        'a non-boolean enabled': { enabled: 'true' },
        'a missing authenticated while enabled': { enabled: true },
        'a non-boolean authenticated': {
            enabled: true,
            authenticated: 'yes',
        },
        'invalid protocols': {
            enabled: true,
            authenticated: true,
            protocols: [],
        },
    };
    for (const [name, payload] of Object.entries(rejected)) {
        it(`throws for ${name}`, () => {
            expect(() => parseAccessStatus(payload)).toThrow(
                'Phi returned invalid access protection settings',
            );
        });
    }
});

describe('parseCredentialBundle', () => {
    it('maps the wire names to the bundle', () => {
        expect(parseCredentialBundle(bundle())).toEqual({
            token: 'token-1',
            expiresAt: 1_800_000_000_000,
            expiresIn: 3_600,
            refreshIdleExpiresAt: 1_800_000_100_000,
            refreshAbsoluteExpiresAt: 1_800_000_200_000,
        });
    });

    it('ignores unrelated fields', () => {
        expect(parseCredentialBundle(bundle({ extra: 'ignored' }))).toEqual(
            parseCredentialBundle(bundle()),
        );
    });

    it('does not require a positive expires_in', () => {
        // Only the absolute deadlines and the token are required to be usable;
        // a zero or negative lifetime is still returned and handled by callers.
        for (const expiresIn of [0, -1]) {
            expect(
                parseCredentialBundle(bundle({ expires_in: expiresIn }))
                    ?.expiresIn,
            ).toBe(expiresIn);
        }
    });

    const rejected = {
        null: null,
        array: [],
        string: 'token',
        'an empty token': bundle({ token: '' }),
        'a non-string token': bundle({ token: 7 }),
        'a missing expires_at': bundle({ expires_at: undefined }),
        'a fractional expires_at': bundle({ expires_at: 1.5 }),
        'a string expires_in': bundle({ expires_in: '3600' }),
        'a zero refresh_idle_expires_at': bundle({
            refresh_idle_expires_at: 0,
        }),
        'a negative refresh_idle_expires_at': bundle({
            refresh_idle_expires_at: -1,
        }),
        'a zero refresh_absolute_expires_at': bundle({
            refresh_absolute_expires_at: 0,
        }),
        'an idle deadline past the absolute one': bundle({
            refresh_idle_expires_at: 1_800_000_200_001,
        }),
    };
    for (const [name, payload] of Object.entries(rejected)) {
        it(`returns null for ${name}`, () => {
            expect(parseCredentialBundle(payload)).toBeNull();
        });
    }

    it('accepts an idle deadline equal to the absolute one', () => {
        expect(
            parseCredentialBundle(
                bundle({
                    refresh_idle_expires_at: 1_800_000_200_000,
                }),
            ),
        ).not.toBeNull();
    });
});
