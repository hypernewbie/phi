import { randomBytes } from 'node:crypto';
import type {
  StreamDeckRelayRequest,
  StreamDeckRelayRequestContext,
} from './streamdeck-relay.js';

const MAX_STATE_BYTES = 128 * 1024;
const MAX_TABS = 128;
const MAX_ID_BYTES = 128;
const MAX_LABEL_BYTES = 128;
const HEARTBEAT_MS = 10_000;
const PAGE_STATE_PROJECTION = `function project(s){
  if(!s||s.version!==1||!Array.isArray(s.tabs)||s.tabs.length>${MAX_TABS})return null;
  const tabs=[];
  for(const t of s.tabs){
    if(!t||typeof t!=='object')return null;
    tabs.push({paneId:t.paneId,label:t.label,type:t.type,selected:t.selected,connection:t.connection});
  }
  const value={version:s.version,documentNonce:s.documentNonce,revision:s.revision,activePaneId:s.activePaneId,tabs};
  const text=JSON.stringify(value);
  return typeof text==='string'&&new TextEncoder().encode(text).byteLength<=${MAX_STATE_BYTES}?text:null;
}`;
const GET_STATE_SCRIPT = `(()=>{try{${PAGE_STATE_PROJECTION}return project(window.__phiStreamDeck?.getState?.())}catch{return null}})()`;
const CANCEL_WAIT_SCRIPT = `(()=>{try{window.__phiStreamDeck?.cancelWait?.()}catch{}})()`;

interface ScriptableWebContents {
  isDestroyed(): boolean;
  executeJavaScript(script: string): Promise<unknown>;
}

export interface StreamDeckActivePage {
  profileId: string;
  webContents: ScriptableWebContents;
}

export interface StreamDeckViewSource {
  getActiveReadyView(): StreamDeckActivePage | null;
}

export interface StreamDeckTabState {
  paneId: string;
  label: string;
  type: string;
  selected: boolean;
  connection: 'connected' | 'connecting' | 'disconnected' | 'local' | 'unknown';
}

export type StreamDeckState =
  | { status: 'unavailable' }
  | {
      status: 'available';
      version: 1;
      profileId: string;
      epoch: string;
      revision: number;
      activePaneId: string | null;
      tabs: StreamDeckTabState[];
    };

interface PageState {
  documentNonce: string;
  revision: number;
  activePaneId: string | null;
  tabs: StreamDeckTabState[];
}

interface PageContext {
  profileId: string;
  webContents: ScriptableWebContents;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validBoundedString(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= maxBytes
  );
}

function parsePageState(serialized: unknown): PageState | null {
  if (
    typeof serialized !== 'string' ||
    Buffer.byteLength(serialized, 'utf8') > MAX_STATE_BYTES
  ) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.documentNonce !== 'string' ||
    !/^[0-9a-f]{32}$/.test(value.documentNonce) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !(
      value.activePaneId === null ||
      validBoundedString(value.activePaneId, MAX_ID_BYTES)
    ) ||
    !Array.isArray(value.tabs) ||
    value.tabs.length > MAX_TABS
  ) {
    return null;
  }
  const tabs: StreamDeckTabState[] = [];
  const paneIds = new Set<string>();
  for (const item of value.tabs) {
    if (
      !isRecord(item) ||
      !validBoundedString(item.paneId, MAX_ID_BYTES) ||
      typeof item.label !== 'string' ||
      Buffer.byteLength(item.label, 'utf8') > MAX_LABEL_BYTES ||
      typeof item.type !== 'string' ||
      ![
        'pi',
        'pi-rpc',
        'review',
        'kanban',
        'claude',
        'codex',
        'other',
      ].includes(item.type) ||
      typeof item.selected !== 'boolean' ||
      !['connected', 'connecting', 'disconnected', 'local', 'unknown'].includes(
        item.connection as string,
      ) ||
      paneIds.has(item.paneId)
    ) {
      return null;
    }
    paneIds.add(item.paneId);
    tabs.push({
      paneId: item.paneId,
      label: item.label,
      type: item.type,
      selected: item.selected,
      connection: item.connection as StreamDeckTabState['connection'],
    });
  }
  const selected = tabs.filter((tab) => tab.selected);
  if (
    selected.length > 1 ||
    (value.activePaneId === null && selected.length !== 0) ||
    (value.activePaneId !== null &&
      (selected.length !== 1 || selected[0].paneId !== value.activePaneId))
  ) {
    return null;
  }
  return {
    documentNonce: value.documentNonce,
    revision: value.revision as number,
    activePaneId: value.activePaneId as string | null,
    tabs,
  };
}

function pageWaitScript(revision: number): string {
  const encodedRevision = JSON.stringify(revision);
  return `(async()=>{try{${PAGE_STATE_PROJECTION}
    const a=window.__phiStreamDeck;
    if(!a||typeof a.waitForRevision!=='function')return null;
    const r=await a.waitForRevision(${encodedRevision},${HEARTBEAT_MS});
    if(r?.kind==='changed'){
      const state=project(r.state);
      return state?JSON.stringify({kind:'changed',state}):null;
    }
    return JSON.stringify({kind:r?.kind||'unavailable'});
  }catch{return null}})()`;
}

function parseWaitResult(
  value: unknown,
):
  | { kind: 'changed'; state: PageState }
  | { kind: 'timeout' | 'cancelled' | 'disposed' | 'unavailable' }
  | null {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > MAX_STATE_BYTES
  ) {
    return null;
  }
  let result: unknown;
  try {
    result = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isRecord(result) || typeof result.kind !== 'string') return null;
  if (result.kind === 'changed') {
    const state = parsePageState(result.state);
    return state ? { kind: 'changed', state } : null;
  }
  if (
    ['timeout', 'cancelled', 'disposed', 'unavailable'].includes(result.kind)
  ) {
    return {
      kind: result.kind as 'timeout' | 'cancelled' | 'disposed' | 'unavailable',
    };
  }
  return null;
}

function newEpoch(): string {
  return randomBytes(16).toString('hex');
}

/** Fenced, bounded access to the selected retained Phi page. */
export class StreamDeckViewSession {
  private readonly source: StreamDeckViewSource;
  private epoch = newEpoch();
  private documentNonce: string | null = null;
  private watching = false;
  private watcher: Promise<void> | null = null;
  private stopCurrent: (() => void) | null = null;
  private wakeCurrent: (() => void) | null = null;
  private waitContext: PageContext | null = null;

  constructor(source: StreamDeckViewSource) {
    this.source = source;
  }

  invalidate(): void {
    this.epoch = newEpoch();
    this.documentNonce = null;
    const context = this.waitContext;
    this.waitContext = null;
    if (context) {
      try {
        if (!context.webContents.isDestroyed()) {
          // Do not let a wedged renderer block lifecycle transitions.
          void context.webContents
            .executeJavaScript(CANCEL_WAIT_SCRIPT)
            .catch(() => {});
        }
      } catch {
        // The view may close between the destroyed check and cancellation.
      }
    }
    this.wakeCurrent?.();
    this.wakeCurrent = null;
  }

  async getState(): Promise<StreamDeckState> {
    const context = this.captureContext();
    if (!context) return { status: 'unavailable' };
    const epoch = this.epoch;
    let serialized: unknown;
    try {
      serialized =
        await context.webContents.executeJavaScript(GET_STATE_SCRIPT);
    } catch {
      return { status: 'unavailable' };
    }
    if (!this.isCurrent(context, epoch)) return { status: 'unavailable' };
    const pageState = parsePageState(serialized);
    if (!pageState) return { status: 'unavailable' };
    if (this.documentNonce && this.documentNonce !== pageState.documentNonce) {
      this.invalidate();
    }
    this.documentNonce = pageState.documentNonce;
    return this.wrapState(context.profileId, pageState);
  }

  async handleRequest(
    request: StreamDeckRelayRequest,
    requestContext: StreamDeckRelayRequestContext,
  ): Promise<unknown> {
    if (!requestContext.isCurrent()) return { status: 'unavailable' };
    if (request.op === 'stepThinking') return { status: 'unsupported' };
    if (request.op === 'getState') {
      const state = await this.getState();
      return requestContext.isCurrent() ? state : { status: 'unavailable' };
    }
    if (request.op === 'bindCurrent') {
      const state = await this.getState();
      if (
        !requestContext.isCurrent() ||
        state.status !== 'available' ||
        !state.activePaneId
      ) {
        return { status: 'unavailable' };
      }
      const tab = state.tabs.find((item) => item.paneId === state.activePaneId);
      return tab
        ? {
            status: 'bound',
            target: {
              version: 1,
              profileId: state.profileId,
              paneId: tab.paneId,
              label: tab.label,
            },
          }
        : { status: 'unavailable' };
    }
    return this.selectTab(request, requestContext);
  }

  startWatching(publish: (state: StreamDeckState) => void): void {
    if (this.watching || this.watcher) return;
    this.watching = true;
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => {
      stop = resolve;
    });
    this.stopCurrent = stop;
    this.watcher = this.watchLoop(publish, stopped).finally(() => {
      if (this.stopCurrent === stop) this.stopCurrent = null;
      this.watcher = null;
    });
  }

  async stopWatching(): Promise<void> {
    if (!this.watching && !this.watcher) return;
    this.watching = false;
    this.stopCurrent?.();
    this.invalidate();
    await this.watcher;
  }

  private async selectTab(
    request: Extract<StreamDeckRelayRequest, { op: 'selectTab' }>,
    requestContext: StreamDeckRelayRequestContext,
  ): Promise<unknown> {
    const state = await this.getState();
    if (
      !requestContext.isCurrent() ||
      state.status !== 'available' ||
      request.epoch !== state.epoch ||
      request.profileId !== state.profileId ||
      !state.tabs.some((tab) => tab.paneId === request.paneId)
    ) {
      return { status: 'unavailable' };
    }
    const context = this.captureContext();
    const epoch = this.epoch;
    const documentNonce = this.documentNonce;
    if (!context || !documentNonce || state.epoch !== epoch) {
      return { status: 'unavailable' };
    }
    let selected: unknown;
    try {
      selected = await context.webContents.executeJavaScript(
        `(()=>{try{return window.__phiStreamDeck?.selectTab?.(${JSON.stringify(request.paneId)})?.ok===true}catch{return false}})()`,
      );
    } catch {
      return { status: 'unavailable' };
    }
    if (
      selected !== true ||
      !requestContext.isCurrent() ||
      !this.isCurrent(context, epoch) ||
      this.documentNonce !== documentNonce
    ) {
      return { status: 'unavailable' };
    }
    const readback = await this.getState();
    if (
      !requestContext.isCurrent() ||
      readback.status !== 'available' ||
      readback.epoch !== epoch ||
      readback.profileId !== request.profileId ||
      readback.activePaneId !== request.paneId
    ) {
      return { status: 'unavailable' };
    }
    return { status: 'selected', state: readback };
  }

  private captureContext(): PageContext | null {
    try {
      const context = this.source.getActiveReadyView();
      if (
        !context ||
        !validBoundedString(context.profileId, MAX_ID_BYTES) ||
        context.webContents.isDestroyed()
      ) {
        return null;
      }
      return context;
    } catch {
      return null;
    }
  }

  private isCurrent(context: PageContext, epoch: string): boolean {
    if (this.epoch !== epoch || context.webContents.isDestroyed()) return false;
    const current = this.captureContext();
    return (
      current !== null &&
      current.profileId === context.profileId &&
      current.webContents === context.webContents
    );
  }

  private wrapState(profileId: string, page: PageState): StreamDeckState {
    return {
      status: 'available',
      version: 1,
      profileId,
      epoch: this.epoch,
      revision: page.revision,
      activePaneId: page.activePaneId,
      tabs: page.tabs,
    };
  }

  private async watchLoop(
    publish: (state: StreamDeckState) => void,
    stopped: Promise<void>,
  ): Promise<void> {
    while (this.watching) {
      const read = await this.raceWithWake(this.getState(), stopped);
      if (read.kind === 'stopped' || !this.watching) return;
      if (read.kind === 'wake') continue;
      const state = read.value;
      try {
        publish(state);
      } catch {
        // Relay snapshot failures must not interrupt the watch loop.
      }
      if (state.status !== 'available') {
        await this.waitForWake(HEARTBEAT_MS, stopped);
        continue;
      }
      const context = this.captureContext();
      if (!context || !this.documentNonce) continue;
      const pageWait = this.waitForPageChange(
        context,
        state.epoch,
        this.documentNonce,
        state.revision,
        publish,
      );
      const result = await this.raceWithWake(pageWait, stopped);
      if (result.kind === 'stopped' || !this.watching) return;
      if (result.kind === 'wake') continue;
    }
  }

  private async waitForPageChange(
    context: PageContext,
    epoch: string,
    nonce: string,
    revision: number,
    publish: (state: StreamDeckState) => void,
  ): Promise<void> {
    this.waitContext = context;
    try {
      const result = await context.webContents.executeJavaScript(
        pageWaitScript(revision),
      );
      if (
        !this.watching ||
        !this.isCurrent(context, epoch) ||
        this.documentNonce !== nonce
      )
        return;
      const parsed = parseWaitResult(result);
      if (parsed?.kind === 'changed') {
        if (parsed.state.documentNonce !== nonce) {
          this.invalidate();
          return;
        }
        const state = this.wrapState(context.profileId, parsed.state);
        try {
          publish(state);
        } catch {
          // Relay snapshot failures must not interrupt the watch loop.
        }
      } else if (parsed?.kind === 'timeout') {
        const state = await this.getState();
        if (this.watching) {
          try {
            publish(state);
          } catch {
            // Relay snapshot failures must not interrupt the watch loop.
          }
        }
      }
    } catch {
      // Page navigation and view teardown both invalidate the current result.
    } finally {
      if (this.waitContext === context) this.waitContext = null;
    }
  }

  private async waitForWake(
    timeoutMs: number,
    stopped: Promise<void>,
  ): Promise<void> {
    let timer: NodeJS.Timeout | null = null;
    let wake!: () => void;
    const wakePromise = new Promise<void>((resolve) => {
      wake = resolve;
      this.wakeCurrent = resolve;
      timer = setTimeout(resolve, timeoutMs);
    });
    try {
      await Promise.race([wakePromise, stopped]);
    } finally {
      if (timer) clearTimeout(timer);
      if (this.wakeCurrent === wake) this.wakeCurrent = null;
    }
  }

  private async raceWithWake<T>(
    work: Promise<T>,
    stopped: Promise<void>,
  ): Promise<
    { kind: 'work'; value: T } | { kind: 'wake' } | { kind: 'stopped' }
  > {
    let wake!: () => void;
    const wakePromise = new Promise<{ kind: 'wake' }>((resolve) => {
      wake = () => resolve({ kind: 'wake' });
      this.wakeCurrent = wake;
    });
    try {
      return await Promise.race([
        work.then((value) => ({ kind: 'work' as const, value })),
        wakePromise,
        stopped.then(() => ({ kind: 'stopped' as const })),
      ]);
    } finally {
      if (this.wakeCurrent === wake) this.wakeCurrent = null;
    }
  }
}
