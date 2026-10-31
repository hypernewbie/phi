import { serverKey } from './util.js';
const QUERY_STORAGE_KEY = 'phi_session_search_query';
let rememberedQuery;
function readRememberedQuery() {
    if (rememberedQuery !== undefined)
        return rememberedQuery;
    try {
        rememberedQuery =
            localStorage.getItem(serverKey(QUERY_STORAGE_KEY)) ?? '';
    }
    catch {
        rememberedQuery = '';
    }
    return rememberedQuery;
}
function rememberQuery(query) {
    rememberedQuery = query;
    try {
        localStorage.setItem(serverKey(QUERY_STORAGE_KEY), query);
    }
    catch {
        // Search stays usable when browser storage is unavailable.
    }
}
function queryTooLong(query) {
    return (Array.from(query).length > 256 ||
        new TextEncoder().encode(query).byteLength > 1024);
}
export function createSessionSearchBar(options) {
    const root = document.createElement('div');
    root.className = 'find-bar';
    root.setAttribute('role', 'search');
    root.setAttribute('aria-label', options.ariaLabel ?? 'Search active session');
    let sourceSelect = null;
    if (options.sources && options.sources.length > 1) {
        sourceSelect = document.createElement('select');
        sourceSelect.className = 'find-source-select';
        sourceSelect.setAttribute('aria-label', 'Search source');
        for (const source of options.sources) {
            const option = document.createElement('option');
            option.value = source.value;
            option.textContent = source.label;
            sourceSelect.appendChild(option);
        }
        const selected = options.sources.some((source) => source.value === options.selectedSource)
            ? options.selectedSource
            : options.sources[0]?.value;
        if (selected)
            sourceSelect.value = selected;
    }
    else {
        const source = document.createElement('span');
        source.className = 'find-source-label';
        source.textContent = options.sourceLabel;
        root.appendChild(source);
    }
    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'find-input';
    input.placeholder = 'Find...';
    input.setAttribute('aria-label', options.ariaLabel ?? 'Search active session');
    input.value = readRememberedQuery();
    const previous = document.createElement('button');
    previous.type = 'button';
    previous.className = 'btn btn-primary find-btn find-prev';
    previous.setAttribute('aria-label', 'Find previous match');
    previous.title = 'Previous match';
    previous.textContent = '▲';
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'btn btn-primary find-btn find-next';
    next.setAttribute('aria-label', 'Find next match');
    next.title = 'Next match';
    next.textContent = '▼';
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'btn btn-primary find-btn find-close';
    closeButton.setAttribute('aria-label', 'Close search');
    closeButton.title = 'Close search';
    closeButton.textContent = '✕';
    const status = document.createElement('span');
    status.className = 'find-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    let preview = null;
    if (options.showPreview) {
        preview = document.createElement('div');
        preview.className = 'find-preview';
        preview.setAttribute('role', 'region');
        preview.setAttribute('aria-label', 'Search result context');
        preview.hidden = true;
    }
    if (sourceSelect)
        root.appendChild(sourceSelect);
    root.append(input, previous, next, closeButton, status);
    if (preview)
        root.appendChild(preview);
    options.container.appendChild(root);
    sourceSelect?.addEventListener('change', () => options.onSourceChange?.(sourceSelect.value));
    let composing = false;
    let closed = false;
    const setStatus = (text, error = true) => {
        status.textContent = text;
        if (text && error)
            status.dataset.error = 'true';
        else
            delete status.dataset.error;
    };
    const setPreview = (text) => {
        if (!preview)
            return;
        preview.textContent = text ?? '';
        preview.hidden = !text;
    };
    const search = () => {
        if (closed || composing)
            return;
        const query = input.value;
        if (queryTooLong(query)) {
            options.onQuery('');
            setPreview(null);
            setStatus('Query too long (max 256 code points / 1024 bytes).');
            return;
        }
        rememberQuery(query);
        setStatus('');
        options.onQuery(query);
    };
    const close = () => {
        if (closed)
            return;
        closed = true;
        root.remove();
        options.onClose();
    };
    input.addEventListener('compositionstart', () => {
        composing = true;
        options.onQuery('');
        setPreview(null);
        setStatus('Composing search query…', false);
    });
    input.addEventListener('compositionend', () => {
        composing = false;
        search();
    });
    input.addEventListener('input', (event) => {
        if (composing || event.isComposing)
            return;
        search();
    });
    root.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            close();
        }
        else if (event.target === input && event.key === 'Enter') {
            event.preventDefault();
            options.onNavigate(event.shiftKey ? 'previous' : 'next');
        }
        event.stopPropagation();
    });
    previous.addEventListener('click', () => options.onNavigate('previous'));
    next.addEventListener('click', () => options.onNavigate('next'));
    closeButton.addEventListener('click', close);
    return {
        root,
        input,
        setStatus,
        setPreview,
        getSource: () => sourceSelect?.value ?? '',
        setSource: (source) => {
            if (sourceSelect &&
                Array.from(sourceSelect.options).some((option) => option.value === source))
                sourceSelect.value = source;
        },
        search,
        close,
    };
}
