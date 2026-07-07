export class FilesManager {
    constructor(app) {
        this.app = app;
        this.treeContainer = document.getElementById('files-tree-container');
        this.treeInstance = null;
        this.lastRefreshCwd = null;
    }

    async refreshFiles(options = {}) {
        const force = options.force !== false;
        const diffCtrl = this.app.diffController;
        if (!force && diffCtrl && (!diffCtrl.isPanelOpen || diffCtrl.activeTab !== 'files')) {
            return;
        }

        const cwd = this.app.sessionsManager.activeCWD || '';
        if (!force && this.lastRefreshCwd === cwd && this.treeInstance) {
            return;
        }

        this.lastRefreshCwd = cwd;
        this.treeContainer.innerHTML = '<div style="color: var(--text-muted); font-size: 12px; padding: 12px;">Scanning workspace...</div>';

        try {
            const res = await fetch(`/api/files/tree?cwd=${encodeURIComponent(cwd)}`);
            if (!res.ok) throw new Error(await res.text() || 'Failed to fetch tree');
            const data = await res.json();

            this.treeContainer.innerHTML = '';
            if (!data || data.length === 0) {
                this.treeContainer.innerHTML = '<div style="color: var(--text-muted); font-size: 12px; padding: 12px;">Workspace is empty.</div>';
                return;
            }

            const transformNode = (node) => {
                const isDir = node.is_dir;
                return {
                    name: node.name,
                    expanded: false,
                    children: node.children ? node.children.map(transformNode) : [],
                    id: node.path,
                    is_dir: isDir
                };
            };
            const transformedData = data.map(transformNode);

            if (typeof TreeView === 'undefined') {
                this.treeContainer.innerHTML = '<div style="color: var(--text-muted); font-size: 12px; padding: 12px;">Error: TreeView library not loaded.</div>';
                return;
            }

            this.treeInstance = new TreeView(transformedData, 'files-tree-container');
            
            this.treeInstance.on('select', (e) => {
                const target = e.target;
                if (!target) return;
                
                const contentEl = target.closest('.tree-leaf-content');
                if (!contentEl) return;
                
                const itemDataStr = contentEl.getAttribute('data-item');
                if (!itemDataStr) return;
                
                const item = JSON.parse(itemDataStr);
                if (item.is_dir) {
                    const leaf = contentEl.closest('.tree-leaf');
                    if (leaf) {
                        const expando = leaf.querySelector('.tree-expando');
                        if (expando) expando.click();
                    }
                    return;
                }

                this.openFileInTerminal(item.id);
            });

        } catch (err) {
            console.error('[files] Failed to load tree:', err);
            this.treeContainer.innerHTML = `<div style="color: var(--text-danger); font-size: 12px; padding: 12px;">Error: ${err.message}</div>`;
        }
    }

    openFileInTerminal(relativeFilePath) {
        const ext = relativeFilePath.split('.').pop().toLowerCase();
        const binaryExtensions = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'pdf', 'zip', 'tar', 'gz', 'exe', 'bin', 'mp4', 'mp3', 'wav', 'webp', 'woff', 'woff2', 'ttf', 'eot'];
        
        if (binaryExtensions.includes(ext)) {
            this.app.showToast(`Cannot open binary file "${relativeFilePath}" in Vim.`, { type: 'warning', title: 'File Browser' });
            return;
        }

        const coder = 'shell';
        const fileArg = `"${relativeFilePath}"`;
        const cmd = `vim ${fileArg}`;

        this.app.sessionsManager.spawnNewSession(coder, cmd);
    }
}
