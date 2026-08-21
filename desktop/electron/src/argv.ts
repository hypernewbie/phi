/**
 * Commander-backed argv parsing for the Electron main process.
 *
 * Centralises every inline `process.argv` scan into a single helper that
 * returns:
 *   - the documented boolean flags (--register-protocol / --unregister-protocol)
 *   - the optional --server=<url> / --server <url> value
 *   - the positional non-flag args (deep links and trailing URLs)
 *   - a reconstructed argv suitable for `classifyInitialLaunch` (the
 *     host-loop helper whose internals are deliberately unchanged:
 *     --server entries are re-injected before the positional args so its
 *     first-wins extraction and forward-channel routing keep working).
 *
 * The parsing surface is the union of what main.ts (boot-time CLI flags,
 * single-instance acquire) and desktop.ts (the smoke self-check, the
 * startup initial launch) used to inline-scan.
 */
import { Command } from 'commander';

export interface ParsedMainArgs {
  /** True when --register-protocol was passed. Wins over --unregister-protocol. */
  registerProtocol: boolean;
  /** True when --unregister-protocol was passed. Ignored when register is set. */
  unregisterProtocol: boolean;
  /** The first --server=<url> or --server <url> value, if any. */
  server: string | undefined;
  /** Non-flag positional args in original order (deep links, trailing URLs). */
  positional: string[];
  /**
   * Reconstructed argv that `classifyInitialLaunch` (whose internals are
   * unchanged) still understands: the --server entries are placed before
   * the positional args so its first-wins --server extraction keeps its
   * current behaviour, and the positional args follow in their original
   * order for the forward-channel classifyArgv pass.
   */
  argvForInitialLaunch: string[];
}

export function parseMainArgs(argv: string[]): ParsedMainArgs {
  // Commander's parser: allow unknown options so future flags don't
  // trip a strict parse, allow excess args, and use parseOptions (the
  // low-level entry that returns operands/unknown without invoking
  // process.exit or emitting help/version). exitOverride is set on the
  // program in case any higher-level path ever reaches .parse().
  const program = new Command()
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .exitOverride()
    .option('--register-protocol', 'install the phi:// protocol handler')
    .option('--unregister-protocol', 'remove the phi:// protocol handler')
    .option('--server <url>', 'explicit server URL to activate at startup');

  const parsed = program.parseOptions(argv);
  const opts = program.opts() as {
    registerProtocol?: unknown;
    unregisterProtocol?: unknown;
    server?: unknown;
  };
  const positional = parsed.operands;

  const server =
    typeof opts.server === 'string' && opts.server !== ''
      ? opts.server
      : undefined;

  // Reconstruct the argv classifyInitialLaunch expects: --server=<server>
  // (when present) followed by every positional arg, preserving order.
  const argvForInitialLaunch: string[] = [];
  if (server !== undefined) argvForInitialLaunch.push(`--server=${server}`);
  for (const arg of positional) argvForInitialLaunch.push(arg);

  return {
    registerProtocol: opts.registerProtocol === true,
    unregisterProtocol: opts.unregisterProtocol === true,
    server,
    positional,
    argvForInitialLaunch,
  };
}
