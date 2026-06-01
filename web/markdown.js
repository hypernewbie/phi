/* Φ phi — Markdown Docs Viewer */

export class MarkdownManager {
    constructor(app) {
        this.app = app;
        this.fileListEl = document.getElementById('markdown-file-list');
        this.modal = document.getElementById('md-modal');
        this.modalTitle = document.getElementById('md-modal-title');
        this.modalBody = document.getElementById('md-modal-body');
        this.modalClose = document.getElementById('md-modal-close');

        this._configureMarked();
        this._setupEventListeners();
    }

    _configureMarked() {
        if (!window.marked) return;
        window.marked.setOptions({
            gfm: true,
            breaks: false,
        });
    }

    _setupEventListeners() {
        this.modalClose.addEventListener('click', () => this.closeModal());
        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal) this.closeModal();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !this.modal.classList.contains('hidden')) {
                this.closeModal();
            }
        });
    }

    async refreshFiles() {
        this.fileListEl.innerHTML = '<div class="md-list-loading">Scanning...</div>';
        const cwd = this.app.sessionsManager.activeCWD || '';
        try {
            const res = await fetch(`/api/markdown/files?cwd=${encodeURIComponent(cwd)}`);
            if (!res.ok) throw new Error(await res.text());
            const files = await res.json();
            this._renderFileList(files);
        } catch (e) {
            this.fileListEl.innerHTML = `<div class="md-list-error">Failed to load: ${e.message}</div>`;
        }
    }

    _renderFileList(files) {
        this.fileListEl.innerHTML = '';

        if (!files || files.length === 0) {
            this.fileListEl.innerHTML = '<div class="md-list-empty">No .md files found in configured dirs.</div>';
            return;
        }

        // Group by dir
        const byDir = {};
        files.forEach(f => {
            if (!byDir[f.dir]) byDir[f.dir] = [];
            byDir[f.dir].push(f);
        });

        for (const [dir, dirFiles] of Object.entries(byDir)) {
            const group = document.createElement('div');
            group.className = 'md-file-group';

            const dirLabel = document.createElement('div');
            dirLabel.className = 'md-dir-label';
            dirLabel.innerText = dir;
            group.appendChild(dirLabel);

            dirFiles.forEach(f => {
                const item = document.createElement('button');
                item.className = 'md-file-item';
                item.innerHTML = `<span class="md-file-icon">📄</span><span class="md-file-name">${f.name}</span>`;
                item.title = f.path;
                item.addEventListener('click', () => this.openFile(f));
                group.appendChild(item);
            });

            this.fileListEl.appendChild(group);
        }

        // Dir management row at the bottom
        const manageRow = document.createElement('div');
        manageRow.className = 'md-manage-row';
        const addDirBtn = document.createElement('button');
        addDirBtn.className = 'md-manage-btn';
        addDirBtn.innerText = '+ Add Dir';
        addDirBtn.addEventListener('click', () => this._promptAddDir());
        manageRow.appendChild(addDirBtn);
        this.fileListEl.appendChild(manageRow);
    }

    async openFile(f) {
        const cwd = this.app.sessionsManager.activeCWD || '';
        this.modalTitle.innerText = f.name;
        this.modalBody.innerHTML = '<div class="md-rendering">Rendering...</div>';
        this.modal.classList.remove('hidden');

        try {
            const res = await fetch(`/api/markdown/file?path=${encodeURIComponent(f.path)}&cwd=${encodeURIComponent(cwd)}`);
            if (!res.ok) throw new Error(await res.text());
            const raw = await res.text();
            const html = window.marked ? window.marked.parse(raw) : `<pre>${this._escape(raw)}</pre>`;
            this.modalBody.innerHTML = `<div class="md-rendered">${html}</div>`;

            // Syntax highlight any code blocks
            if (window.hljs) {
                this.modalBody.querySelectorAll('pre code').forEach(el => {
                    window.hljs.highlightElement(el);
                });
            }
        } catch (e) {
            this.modalBody.innerHTML = `<div class="md-list-error">Failed to load: ${e.message}</div>`;
        }
    }

    closeModal() {
        this.modal.classList.add('hidden');
        this.modalBody.innerHTML = '';
    }

    async _promptAddDir() {
        const dir = prompt("Add markdown directory (relative to workspace, e.g. ./docs):");
        if (!dir || !dir.trim()) return;
        try {
            await fetch('/api/config/markdown-dirs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ dir: dir.trim() })
            });
            this.refreshFiles();
        } catch (e) {
            console.error("Failed to add markdown dir:", e);
        }
    }

    _escape(text) {
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
}
