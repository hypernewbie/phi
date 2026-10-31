// Pi extension factory. Loading is inert without Phi-provisioned
// credentials: no handlers, no connection, no Pi behavior change. The
// first session_start claimant in the process owns the runtime; duplicate
// loads stay inert. Credentials are stashed in the process owner slot and
// removed from process.env so agent-spawned tools cannot inherit them.

import type {
    ExtensionAPI,
    ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { ChannelCreds } from './channel.js';
import {
    type ReloadLatchState,
    captureNativeReloadBaseline,
    freshReloadLatch,
} from './native-reload.js';
import {
    type CompactLatchState,
    type PiContextView,
    type PiSkillView,
    Runtime,
    freshCompactLatch,
} from './runtime.js';
import {
    createSyncboardToolManager,
    type SyncboardRuntime,
} from './syncboard.js';

export const ENV_TARGET = 'PHI_PI_BRIDGE_ENDPOINT';
export const ENV_PANE = 'PHI_PI_BRIDGE_PANE_ID';
export const ENV_PROCESS = 'PHI_PI_BRIDGE_PROCESS_ID';
export const ENV_TOKEN = 'PHI_PI_BRIDGE_TOKEN';

/** Pi exposes every skill as a slash command with this prefix. */
const SKILL_COMMAND_PREFIX = 'skill:';

const OWNER_KEY = Symbol.for('phi.pi-phi.owner');

interface OwnerSlot {
    active: boolean;
    generation: bigint;
    creds?: ChannelCreds | undefined;
    compact?: CompactLatchState | undefined;
    reload?: ReloadLatchState | undefined;
    syncboardOwned?: boolean | undefined;
}

function ownerSlot(): OwnerSlot {
    const existing = (globalThis as Record<symbol, unknown>)[OWNER_KEY] as
        | OwnerSlot
        | undefined;
    if (existing) return existing;
    const fresh: OwnerSlot = { active: false, generation: 0n };
    (globalThis as Record<symbol, unknown>)[OWNER_KEY] = fresh;
    return fresh;
}

/**
 * Process-owned compaction latch: single-flight and Compact-ID
 * high-water protection shared by every runtime in the process.
 * Created once; reconnect and runtime replacement keep it.
 */
export function ownerCompactState(): CompactLatchState {
    const slot = ownerSlot();
    if (!slot.compact) slot.compact = freshCompactLatch();
    return slot.compact;
}

/** Process-owned native Reload baseline and single-flight state. */
export function ownerReloadState(): ReloadLatchState {
    const slot = ownerSlot();
    if (!slot.reload) slot.reload = freshReloadLatch();
    return slot.reload;
}

/** Visible for tests to reset process-global ownership. */
export function resetOwnerSlotForTest(): void {
    (globalThis as Record<symbol, unknown>)[OWNER_KEY] = {
        active: false,
        generation: 0n,
        syncboardOwned: false,
    } as OwnerSlot;
}

/** Read provisioned credentials from the child environment. */
export function readCredsFromEnv(
    env: NodeJS.ProcessEnv = process.env,
): ChannelCreds | null {
    const target = env[ENV_TARGET];
    const pane = env[ENV_PANE];
    const process = env[ENV_PROCESS];
    const token = env[ENV_TOKEN];
    if (!target || !pane || !process || !token) return null;
    return { target, pane, process, token };
}

/** Remove provisioned credentials so later tools cannot inherit them. */
export function clearCredsFromEnv(env: NodeJS.ProcessEnv = process.env): void {
    delete env[ENV_TARGET];
    delete env[ENV_PANE];
    delete env[ENV_PROCESS];
    delete env[ENV_TOKEN];
}

function contextView(ctx: ExtensionContext): PiContextView {
    const sessionManager = ctx.sessionManager;
    const getBranch = (sessionManager as unknown as { getBranch?: unknown })
        .getBranch;
    return {
        sessionManager: {
            getSessionId: () => sessionManager.getSessionId(),
            getLeafId: () => sessionManager.getLeafId(),
            ...(typeof getBranch === 'function'
                ? {
                      getBranch: (fromId?: string) =>
                          getBranch.call(
                              sessionManager,
                              fromId,
                          ) as readonly unknown[],
                  }
                : {}),
        },
        get model() {
            return ctx.model ?? undefined;
        },
        modelRegistry: ctx.modelRegistry,
        scopedModels: ctx.scopedModels,
        ui: ctx.ui,
        // Optional telemetry APIs, detected defensively: a host
        // without them stays on lifecycle/history/models behavior.
        getContextUsage:
            typeof ctx.getContextUsage === 'function'
                ? () => ctx.getContextUsage()
                : undefined,
        isIdle:
            typeof ctx.isIdle === 'function' ? () => ctx.isIdle() : undefined,
        hasPendingMessages:
            typeof ctx.hasPendingMessages === 'function'
                ? () => ctx.hasPendingMessages()
                : undefined,
        compact:
            typeof ctx.compact === 'function'
                ? (options) => ctx.compact(options)
                : undefined,
    };
}

/** Cross-version abort reading for agent_settled payloads. */
export function settledAborted(event: unknown): boolean {
    if (typeof event !== 'object' || event === null) return false;
    return (event as { aborted?: unknown }).aborted === true;
}

/**
 * Final assistant stop reason from an agent_end payload, or null when
 * no assistant message is present. 1.0.1 settlements carry no abort
 * flag, so this evidence classifies them.
 */
export function agentEndStopReason(event: unknown): string | null {
    if (!isRecord(event) || !Array.isArray(event.messages)) return null;
    const messages = event.messages as unknown[];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (!isRecord(message) || message.role !== 'assistant') continue;
        return typeof message.stopReason === 'string'
            ? (message.stopReason as string)
            : null;
    }
    return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/**
 * True when the user disabled the Phi bridge in Pi settings
 * (`phiBridge: { enabled: false }`). Missing settings API, missing
 * section, or any read failure means enabled: the bridge must not
 * silently die on hosts or settings it does not understand.
 *
 * Callable only from event handlers: during factory load `getSettings`
 * is a stub that throws "Extension runtime not initialized" on both
 * pinned hosts (verified by the M7 runtime probe), so a factory-time
 * check can never observe the disable.
 */
function bridgeDisabled(pi: ExtensionAPI): boolean {
    try {
        // SAFETY: getSettings exists in the pinned types but is only
        // callable after runtime bind; the optional call stays safe on
        // every version, and any failure means enabled.
        const api = pi as unknown as { getSettings?: () => unknown };
        const settings = api.getSettings?.();
        if (!isRecord(settings)) return false;
        const section = settings.phiBridge;
        if (!isRecord(section)) return false;
        return section.enabled === false;
    } catch {
        return false;
    }
}

/** Narrow runtime surface the factory needs; Runtime satisfies it. */
export interface FactoryRuntime {
    start(ctx: PiContextView): void;
    onSessionStart(ctx: PiContextView): void;
    onAgentStart(ctx: PiContextView): void;
    onAgentEnd(stopReason: string | null): void;
    onTurnEnd(ctx: PiContextView): void;
    onAgentSettled(ctx: PiContextView, aborted: boolean): void;
    onMessageStart(ctx: PiContextView, role: unknown): void;
    onModelSelect(ctx: PiContextView): void;
    onThinkingLevelSelect(ctx: PiContextView): void;
    onSessionTree(ctx: PiContextView): void;
    onCompactStart(ctx: PiContextView): void;
    onCompactEnd(ctx: PiContextView): void;
    shutdown(): void;
    requestSyncboard?: SyncboardRuntime['requestSyncboard'];
}

export interface FactoryDeps {
    makeRuntime?: (
        creds: ChannelCreds,
        generation: bigint,
        compact: CompactLatchState,
        reload: ReloadLatchState,
        syncboardEnabled?: boolean,
        onSyncboardAvailability?: (available: boolean) => void,
    ) => FactoryRuntime;
}

/**
 * Extension factory. Registers lifecycle handlers only when credentials
 * are provisioned (environment) or stashed (reload in a provisioned
 * process). Long-lived resources start from session_start, never here.
 */
export function createExtension(
    pi: ExtensionAPI,
    deps: FactoryDeps = {},
): void {
    const envCreds = readCredsFromEnv();
    if (!envCreds && !ownerSlot().creds) return;

    let runtime: FactoryRuntime | null = null;
    let claimed = false;
    let sessionId: string | null = null;
    const syncboardTools = createSyncboardToolManager(pi, {
        currentRuntime: () => {
            const current = runtime as
                | (FactoryRuntime & {
                      requestSyncboard?: SyncboardRuntime['requestSyncboard'];
                  })
                | null;
            return current && typeof current.requestSyncboard === 'function'
                ? (current as FactoryRuntime & SyncboardRuntime)
                : null;
        },
        disabled: () => bridgeDisabled(pi),
        isOwned: () => ownerSlot().syncboardOwned === true,
        setOwned: (owned) => {
            ownerSlot().syncboardOwned = owned;
        },
    });

    const nativeThinking = pi as Partial<
        Pick<ExtensionAPI, 'getThinkingLevel' | 'setThinkingLevel'>
    >;
    const getThinkingLevel =
        typeof nativeThinking.getThinkingLevel === 'function'
            ? nativeThinking.getThinkingLevel.bind(pi)
            : undefined;
    const setThinkingLevel =
        typeof nativeThinking.setThinkingLevel === 'function'
            ? nativeThinking.setThinkingLevel.bind(pi)
            : undefined;
    // Skills need both host calls: the command registry lists them and
    // sendUserMessage delivers one. Either one missing keeps the
    // capability off.
    const nativeSkills = pi as Partial<
        Pick<ExtensionAPI, 'getCommands' | 'sendUserMessage'>
    >;
    const hasSkillsApi = typeof nativeSkills.getCommands === 'function';
    const hasInvokeApi = typeof nativeSkills.sendUserMessage === 'function';
    const make: NonNullable<FactoryDeps['makeRuntime']> =
        deps.makeRuntime ??
        ((c, g, compact, reload, syncboardEnabled, onSyncboardAvailability) =>
            new Runtime({
                creds: c,
                generation: g,
                compactState: compact,
                reloadState: reload,
                syncboardEnabled: syncboardEnabled === true,
                ...(onSyncboardAvailability ? { onSyncboardAvailability } : {}),
                setModel: (model) => pi.setModel(model),
                ...(getThinkingLevel ? { getThinkingLevel } : {}),
                ...(setThinkingLevel ? { setThinkingLevel } : {}),
                ...(hasSkillsApi ? { getSkills: () => hostSkills(pi) } : {}),
                ...(hasInvokeApi
                    ? {
                          invokeSkill: (name: string) =>
                              hostInvokeSkill(pi, name),
                      }
                    : {}),
            }));
    const makeOwnedRuntime = (
        creds: ChannelCreds,
        generation: bigint,
        syncboardEnabled: boolean,
    ): FactoryRuntime => {
        let created: FactoryRuntime | null = null;
        created = make(
            creds,
            generation,
            ownerCompactState(),
            ownerReloadState(),
            syncboardEnabled,
            (available) => {
                if (runtime === created) syncboardTools.setAvailable(available);
            },
        );
        return created;
    };

    pi.on('session_start', (_event, ctx) => {
        const slot = ownerSlot();
        if (bridgeDisabled(pi)) {
            syncboardTools.setAvailable(false);
            // Disabled in Pi settings: scrub every credential copy and
            // stay inert. Checked here, not in the factory, because
            // getSettings is not callable until the runtime is bound.
            clearCredsFromEnv();
            slot.creds = undefined;
            if (runtime !== null) {
                runtime.shutdown();
                runtime = null;
            }
            slot.active = false;
            claimed = false;
            return;
        }
        if (slot.active) {
            if (!claimed || runtime === null) return;
            // A replacement session on our claimed runtime: read its
            // identity, and retire into a fresh runtime only when the
            // session actually changed. A duplicate announcement for
            // the same session just refreshes the view.
            let next: string | null = null;
            try {
                next = ctx.sessionManager.getSessionId();
            } catch {
                next = null;
            }
            if (next === null || next === sessionId) {
                captureNativeReloadBaseline(ctx, ownerReloadState());
                runtime.onSessionStart(contextView(ctx));
                return;
            }
            runtime.shutdown();
            const reloadState = ownerReloadState();
            captureNativeReloadBaseline(ctx, reloadState);
            slot.generation += 1n;
            sessionId = next;
            const syncboardEnabled = syncboardTools.prepare();
            runtime = makeOwnedRuntime(
                slot.creds!,
                slot.generation,
                syncboardEnabled,
            );
            runtime.start(contextView(ctx));
            return;
        }
        const creds = readCredsFromEnv() ?? slot.creds;
        if (!creds) return;
        slot.creds = creds;
        clearCredsFromEnv();
        slot.active = true;
        slot.generation += 1n;
        claimed = true;
        try {
            sessionId = ctx.sessionManager.getSessionId();
        } catch {
            sessionId = null;
        }
        const reloadState = ownerReloadState();
        captureNativeReloadBaseline(ctx, reloadState);
        const syncboardEnabled = syncboardTools.prepare();
        runtime = makeOwnedRuntime(creds, slot.generation, syncboardEnabled);
        runtime.start(contextView(ctx));
    });

    pi.on('agent_start', (_event, ctx) => {
        runtime?.onAgentStart(contextView(ctx));
    });

    pi.on('agent_end', (event) => {
        runtime?.onAgentEnd(agentEndStopReason(event));
    });

    pi.on('turn_end', (_event, ctx) => {
        runtime?.onTurnEnd(contextView(ctx));
    });

    pi.on('agent_settled', (event, ctx) => {
        runtime?.onAgentSettled(contextView(ctx), settledAborted(event));
    });

    pi.on('message_start', (event, ctx) => {
        // Role only: message contents never cross the bridge.
        const role = (event as { message?: { role?: unknown } }).message?.role;
        runtime?.onMessageStart(contextView(ctx), role);
    });

    pi.on('model_select', (_event, ctx) => {
        runtime?.onModelSelect(contextView(ctx));
    });

    pi.on('thinking_level_select', (_event, ctx) => {
        runtime?.onThinkingLevelSelect(contextView(ctx));
    });

    pi.on('session_tree', (_event, ctx) => {
        runtime?.onSessionTree(contextView(ctx));
    });

    pi.on('session_before_compact', (_event, ctx) => {
        runtime?.onCompactStart(contextView(ctx));
    });

    const compactEnd = (_event: unknown, ctx: ExtensionContext): void => {
        runtime?.onCompactEnd(contextView(ctx));
    };
    pi.on('session_compact', compactEnd);
    pi.on('session_compact_failed', compactEnd);

    pi.on('session_shutdown', () => {
        syncboardTools.setAvailable(false);
        runtime?.shutdown();
        runtime = null;
        if (claimed) {
            ownerSlot().active = false;
            claimed = false;
        }
    });
}

/**
 * Live skill list from the host command registry. Only commands the
 * host reports with source "skill" are skills; the "skill:" prefix is
 * stripped so the wire carries the bare name. A command without that
 * prefix is not a skill and is skipped.
 */
export function hostSkills(pi: ExtensionAPI): PiSkillView[] {
    const api = pi as Partial<Pick<ExtensionAPI, 'getCommands'>>;
    const commands = api.getCommands?.();
    if (!Array.isArray(commands)) return [];
    const out: PiSkillView[] = [];
    for (const command of commands) {
        if (command?.source !== 'skill') continue;
        const name =
            typeof command.name === 'string' &&
            command.name.startsWith(SKILL_COMMAND_PREFIX)
                ? command.name.slice(SKILL_COMMAND_PREFIX.length)
                : '';
        if (name === '') continue;
        out.push({
            name,
            description:
                typeof command.description === 'string'
                    ? command.description
                    : '',
        });
    }
    return out;
}

/**
 * Send one skill to the host session. The host expands the command
 * into the skill body; the call is fire-and-forget, so a later
 * host-side failure is not observable here.
 */
export function hostInvokeSkill(pi: ExtensionAPI, name: string): void {
    const api = pi as Partial<Pick<ExtensionAPI, 'sendUserMessage'>>;
    api.sendUserMessage?.(`/${SKILL_COMMAND_PREFIX}${name}`, {
        expandPromptTemplates: true,
        deliverAs: 'followUp',
    });
}

export default function (pi: ExtensionAPI): void {
    createExtension(pi);
}
