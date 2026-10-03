function pathParts(path) {
    const windows = /^[A-Za-z]:[\\/]/u.test(path) || /^\\\\/u.test(path);
    const normalized = windows ? path.replace(/\\/gu, '/') : path;
    const drive = normalized.match(/^([A-Za-z]):\//u);
    const root = drive
        ? `drive:${drive[1].toLowerCase()}`
        : normalized.startsWith('/')
            ? '/'
            : '';
    const remainder = drive
        ? normalized.slice(3)
        : normalized.startsWith('/')
            ? normalized.replace(/^\/+/, '')
            : normalized;
    const segments = [];
    for (const segment of remainder.split('/')) {
        if (!segment || segment === '.')
            continue;
        if (segment === '..') {
            if (segments.length > 0 && segments.at(-1) !== '..')
                segments.pop();
            else if (!root)
                segments.push(segment);
            continue;
        }
        segments.push(windows ? segment.toLowerCase() : segment);
    }
    return { root, segments };
}
function pathKey(path) {
    const parts = pathParts(path);
    return `${parts.root}\u0000${parts.segments.join('\u0000')}`;
}
function samePath(left, right) {
    return pathKey(left) === pathKey(right);
}
function isWithinPath(root, path) {
    const parent = pathParts(root);
    const child = pathParts(path);
    return (parent.root === child.root &&
        parent.segments.length <= child.segments.length &&
        parent.segments.every((segment, index) => segment === child.segments[index]));
}
function pathName(path) {
    const windows = /^[A-Za-z]:[\\/]/u.test(path) || /^\\\\/u.test(path);
    const normalized = windows ? path.replace(/\\/gu, '/') : path;
    const trimmed = normalized.replace(/\/+$/u, '');
    const name = trimmed.slice(trimmed.lastIndexOf('/') + 1);
    return name || normalized || path;
}
async function browse(path) {
    const response = await fetch(`/api/fs/browse?path=${encodeURIComponent(path)}`);
    if (!response.ok)
        throw new Error('Unable to browse this directory.');
    const data = (await response.json());
    if (typeof data.path !== 'string' ||
        typeof data.parent !== 'string' ||
        !Array.isArray(data.entries) ||
        typeof data.truncated !== 'boolean' ||
        data.entries.some((entry) => !entry ||
            typeof entry.name !== 'string' ||
            typeof entry.path !== 'string')) {
        throw new Error('The directory response is invalid.');
    }
    return data;
}
function makeNode(name, path, parent = '') {
    return {
        key: pathKey(path),
        name,
        path,
        parent,
        children: [],
        loaded: false,
        truncated: false,
        expanded: false,
        pending: false,
        error: '',
        requestId: 0,
        pendingRequest: null,
        element: null,
        row: null,
        disclosure: null,
        label: null,
        state: null,
        retry: null,
        group: null,
        emptyState: null,
        truncatedState: null,
    };
}
function mountDirectoryTree(host, options) {
    const controls = document.createElement('div');
    controls.className = 'directory-tree-controls';
    const upButton = document.createElement('button');
    upButton.type = 'button';
    upButton.className = 'btn btn-primary directory-tree-up';
    upButton.textContent = 'Up';
    upButton.setAttribute('aria-label', 'Browse parent directory');
    const location = document.createElement('div');
    location.className = 'directory-tree-location';
    location.setAttribute('aria-live', 'polite');
    controls.append(upButton, location);
    const status = document.createElement('div');
    status.className = 'directory-tree-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const tree = document.createElement('div');
    tree.className = 'directory-tree-scroll';
    tree.setAttribute('role', 'tree');
    tree.setAttribute('aria-label', 'Directories on this server');
    host.replaceChildren(controls, status, tree);
    const nodes = new Map();
    let root = makeNode(pathName(options.startPath), options.startPath);
    root.expanded = true;
    nodes.set(root.key, root);
    let selectedKey = '';
    let focusedKey = root.key;
    let rootGeneration = 0;
    let revealGeneration = 0;
    let rootNavigationGeneration = 0;
    let upPending = false;
    let disposed = false;
    let typeahead = '';
    let typeaheadTimer = null;
    const createElement = (node) => {
        const element = document.createElement('div');
        element.className = 'directory-tree-item';
        element.setAttribute('role', 'treeitem');
        const row = document.createElement('div');
        row.className = 'directory-tree-row';
        const disclosure = document.createElement('span');
        disclosure.className = 'directory-tree-disclosure';
        disclosure.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span');
        label.className = 'directory-tree-name';
        const state = document.createElement('span');
        state.className = 'directory-tree-branch-state';
        state.setAttribute('role', 'status');
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'directory-tree-retry';
        retry.textContent = 'Retry';
        retry.hidden = true;
        retry.addEventListener('click', (event) => {
            event.stopPropagation();
            if (disposed)
                return;
            node.error = '';
            node.loaded = false;
            node.expanded = true;
            void loadBranch(node);
        });
        row.append(disclosure, label, state, retry);
        const group = document.createElement('div');
        group.className = 'directory-tree-group';
        group.setAttribute('role', 'group');
        element.append(row, group);
        node.element = element;
        node.row = row;
        node.disclosure = disclosure;
        node.label = label;
        node.state = state;
        node.retry = retry;
        node.group = group;
        return element;
    };
    const nodeForPath = (name, path, parent) => {
        const key = pathKey(path);
        const node = nodes.get(key);
        if (node) {
            node.name = name;
            node.path = path;
            node.parent = parent;
            return node;
        }
        const created = makeNode(name, path, parent);
        nodes.set(created.key, created);
        return created;
    };
    const applyListing = (node, data) => {
        const oldKey = node.key;
        node.path = data.path;
        node.key = pathKey(data.path);
        if (oldKey !== node.key && nodes.get(oldKey) === node)
            nodes.delete(oldKey);
        nodes.set(node.key, node);
        node.parent = data.parent;
        node.truncated = data.truncated;
        node.children = data.entries.map((entry) => nodeForPath(entry.name, entry.path, data.path));
        node.loaded = true;
        node.pending = false;
        node.error = '';
    };
    const isExpandable = (node) => !node.loaded ||
        node.pending ||
        !!node.error ||
        node.children.length > 0;
    const syncChildren = (parent, desired) => {
        for (const child of Array.from(parent.children)) {
            if (!desired.includes(child))
                child.remove();
        }
        desired.forEach((child, index) => {
            const current = parent.children[index] ?? null;
            if (current !== child)
                parent.insertBefore(child, current);
        });
    };
    const collectVisibleNodes = (node) => {
        const visible = [node];
        if (node.expanded && node.loaded) {
            for (const child of node.children) {
                visible.push(...collectVisibleNodes(child));
            }
        }
        return visible;
    };
    const renderNode = (node, level, position, setSize) => {
        const element = node.element ?? createElement(node);
        const expandable = isExpandable(node);
        element.dataset.treeKey = node.key;
        element.dataset.path = node.path;
        element.tabIndex = node.key === focusedKey ? 0 : -1;
        element.setAttribute('aria-level', String(level));
        element.setAttribute('aria-posinset', String(position));
        element.setAttribute('aria-setsize', String(setSize));
        element.setAttribute('aria-selected', String(node.key === selectedKey));
        if (expandable) {
            element.setAttribute('aria-expanded', String(node.expanded));
        }
        else {
            element.removeAttribute('aria-expanded');
        }
        if (node.pending)
            element.setAttribute('aria-busy', 'true');
        else
            element.removeAttribute('aria-busy');
        node.label.textContent = node.name;
        node.row.title = node.path;
        node.row.style.paddingLeft = `${8 + (level - 1) * 14}px`;
        node.disclosure.textContent = expandable
            ? node.expanded
                ? '▾'
                : '▸'
            : '';
        node.disclosure.classList.toggle('is-expandable', expandable);
        node.state.textContent = node.pending ? 'Loading…' : node.error;
        node.retry.hidden = !node.error;
        node.retry.setAttribute('aria-label', `Retry loading ${node.name}`);
        node.row.classList.toggle('is-selected', node.key === selectedKey);
        const group = node.group;
        group.hidden = !node.expanded;
        const desired = [];
        if (node.expanded && node.loaded) {
            const setSizeForChildren = node.truncated
                ? -1
                : node.children.length;
            node.children.forEach((child, index) => {
                desired.push(renderNode(child, level + 1, index + 1, setSizeForChildren));
            });
            if (node.children.length === 0) {
                node.emptyState ??= document.createElement('div');
                node.emptyState.className = 'directory-tree-empty';
                node.emptyState.setAttribute('role', 'note');
                node.emptyState.textContent = 'No visible subdirectories.';
                desired.push(node.emptyState);
            }
            if (node.truncated) {
                node.truncatedState ??= document.createElement('div');
                node.truncatedState.className = 'directory-tree-truncated';
                node.truncatedState.setAttribute('role', 'note');
                node.truncatedState.textContent =
                    'Directory listing truncated at 1000 entries.';
                desired.push(node.truncatedState);
            }
        }
        syncChildren(group, desired);
        return element;
    };
    const updateControls = () => {
        location.textContent = `Browsing: ${root.path}`;
        upButton.disabled = upPending || !root.parent;
    };
    const renderTree = () => {
        if (disposed)
            return;
        if (!collectVisibleNodes(root).some((node) => node.key === focusedKey)) {
            focusedKey = root.key;
        }
        const rootElement = renderNode(root, 1, 1, 1);
        if (tree.firstElementChild !== rootElement)
            tree.replaceChildren(rootElement);
        updateControls();
    };
    const invalidatePendingBranches = () => {
        for (const node of nodes.values()) {
            if (!node.pending)
                continue;
            node.requestId++;
            node.pending = false;
            node.pendingRequest = null;
        }
    };
    const loadBranch = (node) => {
        if (disposed || !node.expanded)
            return Promise.resolve(false);
        if (node.loaded) {
            renderTree();
            return Promise.resolve(true);
        }
        if (node.pendingRequest)
            return node.pendingRequest;
        const requestId = ++node.requestId;
        const generation = rootGeneration;
        node.pending = true;
        node.error = '';
        const request = (async () => {
            try {
                const data = await browse(node.path);
                if (disposed ||
                    generation !== rootGeneration ||
                    requestId !== node.requestId ||
                    !node.expanded) {
                    return false;
                }
                applyListing(node, data);
                return true;
            }
            catch {
                if (disposed ||
                    generation !== rootGeneration ||
                    requestId !== node.requestId ||
                    !node.expanded) {
                    return false;
                }
                node.pending = false;
                node.error = 'Unable to load this directory.';
                return false;
            }
            finally {
                if (!disposed &&
                    generation === rootGeneration &&
                    requestId === node.requestId) {
                    node.pending = false;
                    node.pendingRequest = null;
                    renderTree();
                }
            }
        })();
        node.pendingRequest = request;
        renderTree();
        return request;
    };
    const resumeExpandedBranches = (node) => {
        if (!node.expanded)
            return;
        if (!node.loaded) {
            void loadBranch(node);
            return;
        }
        for (const child of node.children)
            resumeExpandedBranches(child);
    };
    const isCurrentReveal = (generation, rootAtStart) => !disposed &&
        generation === revealGeneration &&
        rootAtStart === rootGeneration;
    const cachedListing = (node) => ({
        path: node.path,
        parent: node.parent,
        truncated: node.truncated,
        entries: node.children.map((child) => ({
            name: child.name,
            path: child.path,
        })),
    });
    const setRootFromListing = (data, explanation = '') => {
        rootNavigationGeneration++;
        upPending = false;
        rootGeneration++;
        invalidatePendingBranches();
        const nextRoot = nodeForPath(pathName(data.path), data.path, data.parent);
        applyListing(nextRoot, data);
        nextRoot.expanded = true;
        root = nextRoot;
        selectedKey = nextRoot.key;
        status.textContent = explanation;
        renderTree();
        resumeExpandedBranches(root);
        return nextRoot;
    };
    const scrollIntoView = (node) => {
        node.row?.scrollIntoView?.({ block: 'nearest' });
    };
    const selectNode = (node, notify) => {
        revealGeneration++;
        selectedKey = node.key;
        focusedKey = node.key;
        renderTree();
        node.element?.focus({ preventScroll: true });
        scrollIntoView(node);
        if (notify)
            options.onSelect(node.path);
    };
    const activeNodeKey = (target) => {
        if (!(target instanceof Element))
            return '';
        return (target.closest('[role="treeitem"]')?.dataset.treeKey ??
            '');
    };
    const isDescendantOf = (path, parent) => isWithinPath(parent, path) && !samePath(path, parent);
    const toggleBranch = (node) => {
        if (!isExpandable(node))
            return;
        if (node.expanded) {
            const activePath = nodes.get(activeNodeKey(document.activeElement))?.path;
            const focusWasHidden = !!activePath && isDescendantOf(activePath, node.path);
            node.expanded = false;
            node.requestId++;
            node.pending = false;
            node.pendingRequest = null;
            revealGeneration++;
            if (focusWasHidden)
                focusedKey = node.key;
            renderTree();
            if (focusWasHidden)
                node.element?.focus({ preventScroll: true });
            return;
        }
        node.expanded = true;
        renderTree();
        if (!node.loaded)
            void loadBranch(node);
    };
    const onTreeClick = (event) => {
        if (!(event.target instanceof Element))
            return;
        const item = event.target.closest('[role="treeitem"]');
        if (!item || !tree.contains(item))
            return;
        const node = nodes.get(item.dataset.treeKey ?? '');
        if (!node)
            return;
        if (event.target.closest('.directory-tree-disclosure')) {
            event.stopPropagation();
            focusedKey = node.key;
            toggleBranch(node);
            node.element?.focus({ preventScroll: true });
            return;
        }
        if (event.target.closest('.directory-tree-retry'))
            return;
        if (event.detail >= 2)
            return;
        selectNode(node, true);
    };
    const onTreeDoubleClick = (event) => {
        if (!(event.target instanceof Element))
            return;
        if (event.target.closest('.directory-tree-disclosure') ||
            event.target.closest('.directory-tree-retry')) {
            return;
        }
        const item = event.target.closest('[role="treeitem"]');
        if (!item || !tree.contains(item))
            return;
        const node = nodes.get(item.dataset.treeKey ?? '');
        if (!node || !isExpandable(node))
            return;
        event.preventDefault();
        focusedKey = node.key;
        toggleBranch(node);
        node.element?.focus({ preventScroll: true });
    };
    const onTreeFocusIn = (event) => {
        const key = activeNodeKey(event.target);
        if (!key)
            return;
        focusedKey = key;
        for (const item of tree.querySelectorAll('[role="treeitem"]')) {
            item.tabIndex = item.dataset.treeKey === focusedKey ? 0 : -1;
        }
    };
    const focusNode = (node) => {
        focusedKey = node.key;
        renderTree();
        node.element?.focus({ preventScroll: true });
        scrollIntoView(node);
    };
    const onTreeKeydown = (event) => {
        if (!(event.target instanceof HTMLElement))
            return;
        const item = event.target.closest('[role="treeitem"]');
        if (!item || event.target !== item || !tree.contains(item))
            return;
        const node = nodes.get(item.dataset.treeKey ?? '');
        if (!node)
            return;
        if (event.key === 'Tab' ||
            event.key === 'Escape' ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.isComposing) {
            return;
        }
        const visibleItems = () => Array.from(tree.querySelectorAll('[role="treeitem"]'));
        const focusVisibleItem = (target) => {
            if (!target)
                return;
            const targetNode = nodes.get(target.dataset.treeKey ?? '');
            if (targetNode)
                focusNode(targetNode);
        };
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const rows = visibleItems();
            const index = rows.indexOf(item);
            const nextIndex = event.key === 'ArrowDown'
                ? Math.min(index + 1, rows.length - 1)
                : Math.max(index - 1, 0);
            focusVisibleItem(rows[nextIndex]);
            return;
        }
        if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            const rows = visibleItems();
            focusVisibleItem(event.key === 'Home' ? rows[0] : rows[rows.length - 1]);
            return;
        }
        if (event.key === 'ArrowRight') {
            event.preventDefault();
            if (isExpandable(node) && !node.expanded) {
                toggleBranch(node);
                focusNode(node);
            }
            else if (node.expanded &&
                node.loaded &&
                node.children.length > 0) {
                focusNode(node.children[0]);
            }
            return;
        }
        if (event.key === 'ArrowLeft') {
            event.preventDefault();
            if (node.expanded && isExpandable(node)) {
                toggleBranch(node);
                focusNode(node);
                return;
            }
            const parentItem = item.parentElement?.closest('[role="treeitem"]');
            if (parentItem)
                focusVisibleItem(parentItem);
            return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            selectNode(node, true);
            return;
        }
        if (event.key.length !== 1)
            return;
        event.preventDefault();
        const character = event.key.toLocaleLowerCase();
        const repeatedCharacter = typeahead.length > 0 &&
            typeahead[0] === character &&
            [...typeahead].every((itemCharacter) => itemCharacter === character);
        typeahead = repeatedCharacter ? character : `${typeahead}${character}`;
        if (typeaheadTimer !== null)
            window.clearTimeout(typeaheadTimer);
        typeaheadTimer = window.setTimeout(() => {
            typeahead = '';
            typeaheadTimer = null;
        }, 700);
        const rows = visibleItems();
        const startIndex = rows.indexOf(item);
        for (let offset = 1; offset <= rows.length; offset++) {
            const candidate = rows[(startIndex + offset) % rows.length];
            const candidateName = candidate.querySelector('.directory-tree-name')?.textContent ??
                '';
            if (candidateName.toLocaleLowerCase().startsWith(typeahead)) {
                focusVisibleItem(candidate);
                break;
            }
        }
    };
    const onUp = async () => {
        const parent = root.parent;
        if (!parent || upPending || disposed)
            return;
        const navigation = ++rootNavigationGeneration;
        const generation = rootGeneration;
        revealGeneration++;
        upPending = true;
        status.textContent = 'Loading parent directory…';
        renderTree();
        try {
            const data = await browse(parent);
            if (disposed ||
                navigation !== rootNavigationGeneration ||
                generation !== rootGeneration) {
                return;
            }
            rootGeneration++;
            invalidatePendingBranches();
            const nextRoot = nodeForPath(pathName(data.path), data.path, data.parent);
            applyListing(nextRoot, data);
            nextRoot.expanded = true;
            root = nextRoot;
            upPending = false;
            status.textContent = '';
            renderTree();
            resumeExpandedBranches(root);
        }
        catch {
            if (!disposed &&
                navigation === rootNavigationGeneration &&
                generation === rootGeneration) {
                upPending = false;
                status.textContent = 'Unable to browse the parent directory.';
                renderTree();
            }
        }
    };
    const reveal = async (path) => {
        const generation = ++revealGeneration;
        rootNavigationGeneration++;
        upPending = false;
        const rootAtStart = rootGeneration;
        const current = () => isCurrentReveal(generation, rootAtStart);
        status.textContent = 'Resolving directory…';
        renderTree();
        let target;
        try {
            const pendingNode = nodes.get(pathKey(path));
            if (pendingNode?.pendingRequest) {
                const loaded = await pendingNode.pendingRequest;
                if (!current())
                    return null;
                if (!loaded || !pendingNode.loaded) {
                    throw new Error('Unable to load this directory.');
                }
                target = cachedListing(pendingNode);
            }
            else {
                target = await browse(path);
            }
        }
        catch {
            if (current())
                status.textContent = '';
            if (current())
                throw new Error('This path is not an accessible directory.');
            return null;
        }
        if (!current())
            return null;
        if (!isWithinPath(root.path, target.path)) {
            const nextRoot = setRootFromListing(target);
            scrollIntoView(nextRoot);
            return target.path;
        }
        const chain = [target];
        let child = target;
        let omitted = false;
        const visited = new Set([pathKey(child.path)]);
        while (!samePath(child.path, root.path)) {
            const parentPath = child.parent;
            if (!parentPath ||
                !isWithinPath(root.path, parentPath) ||
                visited.has(pathKey(parentPath))) {
                omitted = true;
                break;
            }
            visited.add(pathKey(parentPath));
            const parentNode = nodes.get(pathKey(parentPath));
            let parentListing;
            if (parentNode?.loaded) {
                parentNode.expanded = true;
                parentListing = cachedListing(parentNode);
            }
            else if (parentNode) {
                parentNode.expanded = true;
                renderTree();
                const loaded = await loadBranch(parentNode);
                if (!current())
                    return null;
                if (!loaded || !parentNode.loaded) {
                    omitted = true;
                    break;
                }
                parentListing = cachedListing(parentNode);
            }
            else {
                try {
                    parentListing = await browse(parentPath);
                }
                catch {
                    omitted = true;
                    break;
                }
                if (!current())
                    return null;
            }
            if (!samePath(parentListing.path, parentPath) ||
                !parentListing.entries.some((entry) => samePath(entry.path, child.path))) {
                omitted = true;
                break;
            }
            chain.push(parentListing);
            child = parentListing;
        }
        if (!current())
            return null;
        if (omitted || !samePath(child.path, root.path)) {
            const nextRoot = setRootFromListing(target, 'The parent listing did not include this path. Showing it as a separate root.');
            scrollIntoView(nextRoot);
            return target.path;
        }
        for (const listing of chain.reverse()) {
            let node = nodes.get(pathKey(listing.path));
            if (!node) {
                node = nodeForPath(pathName(listing.path), listing.path, listing.parent);
            }
            applyListing(node, listing);
            if (!samePath(node.path, target.path))
                node.expanded = true;
        }
        const selected = nodes.get(pathKey(target.path));
        if (!selected || !current())
            return null;
        selectedKey = selected.key;
        status.textContent = '';
        renderTree();
        scrollIntoView(selected);
        return target.path;
    };
    const onUpClick = () => {
        void onUp();
    };
    tree.addEventListener('click', onTreeClick);
    tree.addEventListener('dblclick', onTreeDoubleClick);
    tree.addEventListener('focusin', onTreeFocusIn);
    tree.addEventListener('keydown', onTreeKeydown);
    upButton.addEventListener('click', onUpClick);
    renderTree();
    void loadBranch(root);
    return {
        reveal,
        invalidateDraft() {
            if (disposed)
                return;
            revealGeneration++;
            selectedKey = '';
            status.textContent = '';
            renderTree();
        },
        destroy() {
            if (disposed)
                return;
            disposed = true;
            rootGeneration++;
            revealGeneration++;
            rootNavigationGeneration++;
            if (typeaheadTimer !== null)
                window.clearTimeout(typeaheadTimer);
            typeaheadTimer = null;
            for (const node of nodes.values()) {
                node.requestId++;
                node.pending = false;
                node.pendingRequest = null;
            }
            tree.removeEventListener('click', onTreeClick);
            tree.removeEventListener('dblclick', onTreeDoubleClick);
            tree.removeEventListener('focusin', onTreeFocusIn);
            tree.removeEventListener('keydown', onTreeKeydown);
            upButton.removeEventListener('click', onUpClick);
            host.replaceChildren();
        },
    };
}
export { mountDirectoryTree };
