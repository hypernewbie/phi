import { mountRpcChat } from './controller.js';
import { getLastFolderName, terminalPreferredFontSize } from '../util.js';

interface TabManagerLike {
    app?: {
        sessionsManager?: { activeWorkspace?: string };
        terminalFontFamily?: string;
        terminalFontSize?: number;
    };
    tabs: Map<string, { termContainer: HTMLElement }>;
    createTab(
        paneId: string,
        sessionId: string,
        title: string,
        coder: string,
        workspace: string,
        cwd: string,
        pinned?: boolean,
        marked?: boolean,
        initialCmd?: string,
        sessionPath?: string | null,
    ): void;
    switchTab(paneId: string): void;
}

function applyTerminalFont(
    container: HTMLElement,
    app: TabManagerLike['app'],
): void {
    const fontSize = terminalPreferredFontSize(app?.terminalFontSize);
    container.style.fontFamily =
        app?.terminalFontFamily || 'JetBrains Mono, monospace';
    container.style.fontSize = `${fontSize}px`;
}

export function openPiRpcChatTab(
    tabManager: TabManagerLike,
    cwd: string,
    sessionPath?: string,
    sessionTitle?: string,
): void {
    // Fresh chats get a phi-minted UUID so each "New session" opens a
    // distinct pi --mode rpc child. Resumed chats keep their session-path
    // key so reopening the same session dedupes to the existing tab.
    const paneId = sessionPath
        ? `pi-rpc:session:${encodeURIComponent(sessionPath)}`
        : `pi-rpc:${crypto.randomUUID()}`;
    if (tabManager.tabs.has(paneId)) {
        tabManager.switchTab(paneId);
        return;
    }

    const title =
        sessionPath && sessionTitle
            ? sessionTitle
            : `Pi RPC · ${getLastFolderName(cwd) || cwd}`;
    const workspace = tabManager.app?.sessionsManager?.activeWorkspace ?? '';
    // The final argument carries the durable resume path: the exact
    // session path for a resumed tab, null for a fresh tab.
    tabManager.createTab(
        paneId,
        '',
        title,
        'pi-rpc',
        workspace,
        cwd,
        true,
        false,
        '',
        sessionPath || null,
    );
    const tab = tabManager.tabs.get(paneId);
    if (!tab) return;
    applyTerminalFont(tab.termContainer, tabManager.app);
    if (sessionPath) {
        mountRpcChat(paneId, tab.termContainer, cwd, sessionPath);
    } else {
        mountRpcChat(paneId, tab.termContainer, cwd);
    }
}
