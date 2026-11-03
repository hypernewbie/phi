// Types for the vendored @noble/hashes build emitted to web/vendor/. The
// source imports the emitted path, so this mirror resolves for the checker
// while the browser loads web/vendor/noble-hashes/pbkdf2.js. Only the
// surface auth.ts calls is declared.
export function pbkdf2Async(
    hash: unknown,
    password: string | Uint8Array,
    salt: Uint8Array,
    options: { c: number; dkLen: number; asyncTick?: number },
): Promise<Uint8Array>;
