import { mountRpcChat } from './controller.js';
import { getLastFolderName } from '../util.js';
function applyTerminalFont(container, app) {
    const configuredSize = app?.terminalFontSize;
    let fontSize = window.innerWidth <= 768 ? 10 : 14;
    const numericSize = Number(configuredSize);
    if (Number.isFinite(numericSize) && numericSize >= 8 && numericSize <= 32) {
        fontSize = numericSize;
    }
    container.style.fontFamily =
        app?.terminalFontFamily || 'JetBrains Mono, monospace';
    container.style.fontSize = `${fontSize}px`;
}
export function openPiRpcChatTab(tabManager, cwd, sessionPath, sessionTitle) {
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
    tabManager.createTab(paneId, '', title, 'pi-rpc', workspace, cwd);
    const tab = tabManager.tabs.get(paneId);
    if (!tab) return;
    applyTerminalFont(tab.termContainer, tabManager.app);
    if (sessionPath) {
        mountRpcChat(paneId, tab.termContainer, cwd, sessionPath);
    } else {
        mountRpcChat(paneId, tab.termContainer, cwd);
    }
}
