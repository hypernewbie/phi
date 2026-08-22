import { mountRpcChat } from './controller.js';
import { getLastFolderName } from '../util.js';
function applyTerminalFont(container, app) {
    const configuredSize = app?.terminalFontSize;
    let fontSize = window.innerWidth <= 768 ? 10 : 14;
    if (typeof configuredSize === 'number' &&
        configuredSize >= 8 &&
        configuredSize <= 32) {
        fontSize = configuredSize;
    }
    container.style.fontFamily =
        app?.terminalFontFamily || 'JetBrains Mono, monospace';
    container.style.fontSize = `${fontSize}px`;
}
export function openPiRpcChatTab(tabManager, cwd, sessionPath, sessionTitle) {
    const paneId = sessionPath
        ? `pi-rpc:session:${encodeURIComponent(sessionPath)}`
        : `pi-rpc:${cwd}`;
    if (tabManager.tabs.has(paneId)) {
        tabManager.switchTab(paneId);
        return;
    }
    const title = sessionPath && sessionTitle
        ? sessionTitle
        : `Pi RPC · ${getLastFolderName(cwd) || cwd}`;
    const workspace = tabManager.app?.sessionsManager?.activeWorkspace ?? '';
    tabManager.createTab(paneId, '', title, 'pi-rpc', workspace, cwd);
    const tab = tabManager.tabs.get(paneId);
    if (!tab)
        return;
    applyTerminalFont(tab.termContainer, tabManager.app);
    if (sessionPath) {
        mountRpcChat(paneId, tab.termContainer, cwd, sessionPath);
    }
    else {
        mountRpcChat(paneId, tab.termContainer, cwd);
    }
}
