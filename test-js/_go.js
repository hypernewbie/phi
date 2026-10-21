import { execFileSync } from 'node:child_process';

// undefined = unresolved, null = unavailable, string = resolved path.
let cachedSdkRoot;

/**
 * Resolve the selected Xcode's macOS SDK once per worker. The bare
 * toolchain default can point at a newer CommandLineTools SDK whose
 * .tbd files the selected linker cannot parse (tapi "unknown
 * architecture"); the --sdk form always resolves to the Xcode SDK
 * contemporaneous with the toolchain. Best-effort: null keeps the
 * default toolchain paths. Non-macOS always returns null.
 */
function darwinSdkRoot() {
    if (process.platform !== 'darwin') return null;
    if (cachedSdkRoot !== undefined) return cachedSdkRoot;
    cachedSdkRoot = null;
    try {
        const out = execFileSync(
            'xcrun',
            ['--sdk', 'macosx', '--show-sdk-path'],
            { encoding: 'utf8', timeout: 15000 },
        ).trim();
        if (out) cachedSdkRoot = out;
    } catch {
        // Fall through with the default toolchain paths.
    }
    return cachedSdkRoot;
}

/**
 * execFileSync('go', ...) with a macOS SDKROOT guard so cgo-linking
 * oracle tests survive toolchain/SDK skew. Respects an explicit
 * SDKROOT in opts.env or the process environment. Same signature and
 * return as execFileSync minus the command.
 */
export function execGoTest(args, opts = {}) {
    const env = { ...process.env, ...(opts.env ?? {}) };
    if (env.SDKROOT === undefined) {
        const sdk = darwinSdkRoot();
        if (sdk) env.SDKROOT = sdk;
    }
    return execFileSync('go', args, { ...opts, env });
}
