import {
    backendStores,
    MAX_BACKEND_STORES,
    type BackendStore,
    type NotificationMetadata,
} from './backend-store.js';
import type { ToastOptions } from './types.js';

type ToastType = NonNullable<ToastOptions['type']>;

type AnimationHandle = { id: number; kind: 'raf' | 'timeout' };

interface ReadyMember {
    title: string;
    message: string;
    type: ToastType;
    actionText: string | null;
    callback: (() => void) | null;
}

interface NotificationContext {
    storageKey: string;
    store: BackendStore;
    snapshot: NotificationMetadata[];
}

interface NotificationEntry {
    id: string;
    title: string;
    message: string;
    type: ToastType;
    timestamp: number;
    context: NotificationContext | null;
    legacy: boolean;
    expired: boolean;
    deadline: number | null;
    actionText: string | null;
    callback: (() => void) | null;
    popup: HTMLDivElement | null;
    fadingPopup: HTMLDivElement | null;
    timer: number | null;
    timerToken: number;
    readyMembers: Map<string, ReadyMember> | null;
    fadeTimer: number | null;
    fadeToken: number;
    animation: AnimationHandle | null;
    row: HTMLElement | null;
    rowTitle: HTMLElement | null;
    rowMessage: HTMLElement | null;
    rowActions: HTMLElement | null;
    rowAction: HTMLButtonElement | null;
    rowDismiss: HTMLButtonElement | null;
}

interface NotificationShell {
    trigger: HTMLButtonElement;
    overlay: HTMLDivElement;
    dialog: HTMLDivElement;
    closeButton: HTMLButtonElement;
    dismissAllButton: HTMLButtonElement;
    list: HTMLDivElement;
    announcements: HTMLDivElement;
    disclosure: HTMLParagraphElement;
    routingStatus: HTMLParagraphElement;
    toastContainer: HTMLDivElement;
    ownedDom: HTMLElement[];
}

const DEFAULT_DURATION = 6000;
const MAX_DURATION = 2_147_483_647;
const MAX_RECORDS = 100;
const MAX_STORAGE_TEXT = 1_500_000;
const MAX_TITLE_PREVIEW = 200;
const MAX_MESSAGE_PREVIEW = 2_000;
const MAX_DIRTY_STORES = MAX_BACKEND_STORES + 1;
const READY_GROUP_DURATION = 6000;
const ROUTING_BLOCK_STORAGE_KEY = 'phi_notification_actions_blocked_v1';
const ROUTING_BLOCK_MESSAGE =
    'Notification actions unavailable until backend routing is confirmed.';
const DEFAULT_TITLES: Record<ToastType, string> = {
    error: 'Error',
    success: 'Done',
    info: 'Notice',
};
const ICONS: Record<ToastType, string> = {
    error: '⚠',
    success: '𓆣',
    info: 'ℹ',
};
const SVG_NS = 'http://www.w3.org/2000/svg';

function normalizeType(type: unknown): ToastType {
    return type === 'error' || type === 'success' ? type : 'info';
}

function normalizeDuration(duration: unknown): number {
    if (
        typeof duration === 'number' &&
        Number.isFinite(duration) &&
        duration >= 0 &&
        duration <= MAX_DURATION
    ) {
        return duration;
    }
    return DEFAULT_DURATION;
}

function normalizeMetadata(value: unknown): NotificationMetadata | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    if (
        typeof record.id !== 'string' ||
        record.id.length === 0 ||
        record.id.length > 64 ||
        (record.type !== 'info' &&
            record.type !== 'success' &&
            record.type !== 'error') ||
        typeof record.title !== 'string' ||
        record.title.length > MAX_TITLE_PREVIEW ||
        typeof record.message !== 'string' ||
        record.message.length > MAX_MESSAGE_PREVIEW ||
        typeof record.timestamp !== 'number' ||
        !Number.isFinite(record.timestamp) ||
        Math.abs(record.timestamp) > 8_640_000_000_000_000
    ) {
        return null;
    }
    return {
        id: record.id,
        type: record.type,
        title: record.title,
        message: record.message,
        timestamp: record.timestamp,
    };
}

function normalizeMetadataList(value: unknown): NotificationMetadata[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const entries: NotificationMetadata[] = [];
    for (const candidate of value.slice(0, MAX_RECORDS)) {
        const entry = normalizeMetadata(candidate);
        if (!entry || seen.has(entry.id)) continue;
        seen.add(entry.id);
        entries.push(entry);
    }
    return entries;
}

function parseStoredNotifications(raw: string | null): NotificationMetadata[] {
    if (!raw || raw.length > MAX_STORAGE_TEXT) return [];
    try {
        const parsed: unknown = JSON.parse(raw);
        if (
            typeof parsed !== 'object' ||
            parsed === null ||
            Array.isArray(parsed) ||
            (parsed as { version?: unknown }).version !== 1
        ) {
            return [];
        }
        return normalizeMetadataList((parsed as { entries?: unknown }).entries);
    } catch {
        return [];
    }
}

function makeButton(
    doc: Document,
    id: string,
    className: string,
    label: string,
): HTMLButtonElement {
    const button = doc.createElement('button');
    button.id = id;
    button.className = className;
    button.type = 'button';
    button.textContent = label;
    return button;
}

function createInboxIcon(doc: Document): SVGSVGElement {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.classList.add('icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const path = doc.createElementNS(SVG_NS, 'path');
    path.setAttribute(
        'd',
        'M4 4h16l2 10v5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-5L4 4z M2 14h5l2 3h6l2-3h5',
    );
    svg.appendChild(path);
    return svg;
}

function createDialogMarkup(doc: Document, overlay: HTMLDivElement): void {
    const dialog = doc.createElement('div');
    dialog.id = 'notifications-drawer';
    dialog.className = 'modal-content notifications-drawer';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'notifications-title');
    dialog.tabIndex = -1;

    const header = doc.createElement('div');
    header.className = 'modal-header notifications-header';
    const title = doc.createElement('h3');
    title.id = 'notifications-title';
    title.textContent = 'Notifications';
    const controls = doc.createElement('div');
    controls.className = 'notifications-header-actions';
    const dismissAll = makeButton(
        doc,
        'notifications-dismiss-all',
        'btn btn-secondary notifications-dismiss-all',
        'Dismiss all',
    );
    dismissAll.disabled = true;
    const close = makeButton(
        doc,
        'notifications-close',
        'modal-close-btn notifications-close',
        '×',
    );
    close.title = 'Close notifications';
    close.setAttribute('aria-label', 'Close notifications');
    controls.append(dismissAll, close);
    header.append(title, controls);

    const routingStatus = doc.createElement('p');
    routingStatus.id = 'notifications-routing-status';
    routingStatus.className = 'notifications-routing-status hidden';
    routingStatus.setAttribute('role', 'status');
    routingStatus.setAttribute('aria-live', 'polite');
    routingStatus.textContent = ROUTING_BLOCK_MESSAGE;
    const list = doc.createElement('div');
    list.id = 'notifications-list';
    list.className = 'modal-body notifications-list';
    const disclosure = doc.createElement('p');
    disclosure.id = 'notifications-disclosure';
    disclosure.className = 'modal-footer notifications-disclosure';
    disclosure.textContent =
        'Last 100 notifications. Saved titles are limited to 200 characters and messages to 2,000 characters.';
    dialog.append(header, routingStatus, list, disclosure);
    overlay.appendChild(dialog);
}

function ensureShell(doc: Document): NotificationShell {
    const ownedDom: HTMLElement[] = [];
    let trigger = doc.getElementById(
        'header-notifications-btn',
    ) as HTMLButtonElement | null;
    if (!trigger) {
        trigger = makeButton(
            doc,
            'header-notifications-btn',
            'header-btn icon-only',
            '',
        );
        ownedDom.push(trigger);
        trigger.title = 'Notifications';
        trigger.setAttribute('aria-label', 'Notifications');
        trigger.appendChild(createInboxIcon(doc));
        trigger.setAttribute('aria-haspopup', 'dialog');
        trigger.setAttribute('aria-controls', 'notifications-drawer');
        trigger.setAttribute('aria-expanded', 'false');
        const settingsButton = doc.getElementById('header-ntfy-btn');
        const actions = settingsButton?.parentElement;
        if (settingsButton && actions)
            actions.insertBefore(trigger, settingsButton);
        else doc.body.appendChild(trigger);
    }

    let overlay = doc.getElementById(
        'notifications-overlay',
    ) as HTMLDivElement | null;
    if (!overlay) {
        overlay = doc.createElement('div');
        ownedDom.push(overlay);
        overlay.id = 'notifications-overlay';
        overlay.className = 'modal-overlay notifications-overlay hidden';
        overlay.setAttribute('aria-hidden', 'true');
        createDialogMarkup(doc, overlay);
        doc.body.appendChild(overlay);
    }

    let dialog = doc.getElementById(
        'notifications-drawer',
    ) as HTMLDivElement | null;
    if (!dialog) {
        createDialogMarkup(doc, overlay);
        dialog = doc.getElementById('notifications-drawer') as HTMLDivElement;
        if (!ownedDom.includes(overlay)) ownedDom.push(dialog);
    }

    let closeButton = doc.getElementById(
        'notifications-close',
    ) as HTMLButtonElement | null;
    if (!closeButton) {
        closeButton = makeButton(
            doc,
            'notifications-close',
            'modal-close-btn notifications-close',
            '×',
        );
        closeButton.title = 'Close notifications';
        closeButton.setAttribute('aria-label', 'Close notifications');
        dialog.querySelector('.notifications-header')?.appendChild(closeButton);
    }

    let dismissAllButton = doc.getElementById(
        'notifications-dismiss-all',
    ) as HTMLButtonElement | null;
    if (!dismissAllButton) {
        dismissAllButton = makeButton(
            doc,
            'notifications-dismiss-all',
            'btn btn-secondary notifications-dismiss-all',
            'Dismiss all',
        );
        dismissAllButton.disabled = true;
        const header = dialog.querySelector('.notifications-header');
        if (header) header.insertBefore(dismissAllButton, closeButton);
    }

    let list = doc.getElementById(
        'notifications-list',
    ) as HTMLDivElement | null;
    if (!list) {
        list = doc.createElement('div');
        list.id = 'notifications-list';
        list.className = 'modal-body notifications-list';
        dialog.appendChild(list);
    }

    let disclosure = doc.getElementById(
        'notifications-disclosure',
    ) as HTMLParagraphElement | null;
    if (!disclosure) {
        disclosure = doc.createElement('p');
        disclosure.id = 'notifications-disclosure';
        disclosure.className = 'modal-footer notifications-disclosure';
        disclosure.textContent =
            'Last 100 notifications. Saved titles are limited to 200 characters and messages to 2,000 characters.';
        dialog.appendChild(disclosure);
    }

    let routingStatus = doc.getElementById(
        'notifications-routing-status',
    ) as HTMLParagraphElement | null;
    if (!routingStatus) {
        routingStatus = doc.createElement('p');
        routingStatus.id = 'notifications-routing-status';
        routingStatus.className = 'notifications-routing-status hidden';
        routingStatus.setAttribute('role', 'status');
        routingStatus.setAttribute('aria-live', 'polite');
        routingStatus.textContent = ROUTING_BLOCK_MESSAGE;
        const list = doc.getElementById('notifications-list');
        if (list) dialog.insertBefore(routingStatus, list);
        else dialog.appendChild(routingStatus);
    }

    let announcements = doc.getElementById(
        'notifications-announcements',
    ) as HTMLDivElement | null;
    if (!announcements) {
        announcements = doc.createElement('div');
        ownedDom.push(announcements);
        announcements.id = 'notifications-announcements';
        announcements.className = 'notifications-announcements';
        announcements.setAttribute('role', 'status');
        announcements.setAttribute('aria-live', 'polite');
        announcements.setAttribute('aria-atomic', 'true');
        doc.body.appendChild(announcements);
    }

    let toastContainer = doc.getElementById(
        'toast-container',
    ) as HTMLDivElement | null;
    if (!toastContainer) {
        toastContainer = doc.createElement('div');
        ownedDom.push(toastContainer);
        toastContainer.id = 'toast-container';
        toastContainer.className = 'toast-container';
        doc.body.appendChild(toastContainer);
    }

    trigger.title = 'Notifications';
    trigger.setAttribute('aria-label', 'Notifications');
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-controls', 'notifications-drawer');
    if (!trigger.hasAttribute('aria-expanded')) {
        trigger.setAttribute('aria-expanded', 'false');
    }
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'notifications-title');

    return {
        trigger,
        overlay,
        dialog,
        closeButton,
        dismissAllButton,
        list,
        announcements,
        disclosure,
        routingStatus,
        toastContainer,
        ownedDom,
    };
}

function isToastElement(node: Node): node is HTMLDivElement {
    return (
        node.nodeType === Node.ELEMENT_NODE &&
        (node as Element).classList.contains('toast')
    );
}

export class NotificationManager {
    private readonly trigger: HTMLButtonElement;
    private readonly overlay: HTMLDivElement;
    private readonly dialog: HTMLDivElement;
    private readonly closeButton: HTMLButtonElement;
    private readonly dismissAllButton: HTMLButtonElement;
    private readonly list: HTMLDivElement;
    private readonly announcements: HTMLDivElement;
    private readonly disclosure: HTMLParagraphElement;
    private readonly routingStatus: HTMLParagraphElement;
    private readonly toastContainer: HTMLDivElement;
    private readonly ownedDom: HTMLElement[];
    private readonly onDestroy: (() => void) | undefined;
    private readonly onReadyTabs: (() => void) | undefined;
    private readonly entries: NotificationEntry[] = [];
    private readonly entriesById = new Map<string, NotificationEntry>();
    private readonly nodeEntries = new WeakMap<
        HTMLElement,
        NotificationEntry | null
    >();
    private readonly observer: MutationObserver | null;
    private readonly dirtyStores = new Map<BackendStore, NotificationContext>();
    private context: NotificationContext | null = null;
    private actionsBlocked = false;
    private nextId = 0;
    private writeTimer: number | null = null;
    private pagehideListening = false;
    private opened = false;
    private destroyed = false;
    private opener: HTMLElement | null = null;
    private emptyState: HTMLParagraphElement | null = null;
    private readyGroup: NotificationEntry | null = null;

    private readonly onPageHide = (): void => this.flushPendingWrites();
    private readonly onTriggerClick = (): void => this.open();
    private readonly onCloseClick = (): void => this.close();
    private readonly onDismissAllClick = (): void => this.dismissAll();
    private readonly onOverlayClick = (event: MouseEvent): void => {
        if (event.target === this.overlay) this.close();
    };
    private readonly onKeyDown = (event: KeyboardEvent): void => {
        if (!this.opened) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            this.close();
            return;
        }
        if (event.key === 'Tab') {
            event.stopPropagation();
            this.trapTab(event);
            return;
        }
        if (
            (event.ctrlKey || event.metaKey) &&
            event.key.toLowerCase() === 'c'
        ) {
            return;
        }
        event.stopPropagation();
    };
    private readonly onOtherKey = (event: KeyboardEvent): void => {
        if (!this.opened) return;
        if (
            (event.ctrlKey || event.metaKey) &&
            event.key.toLowerCase() === 'c'
        ) {
            return;
        }
        event.stopPropagation();
    };
    private readonly onFocusIn = (event: FocusEvent): void => {
        if (
            this.opened &&
            event.target instanceof Node &&
            !this.dialog.contains(event.target)
        ) {
            this.closeButton.focus();
        }
    };

    constructor(
        options: {
            onDestroy?: () => void;
            onReadyTabs?: () => void;
            storageKey?: string;
            store?: BackendStore;
        } = {},
    ) {
        const shell = ensureShell(document);
        this.trigger = shell.trigger;
        this.overlay = shell.overlay;
        this.dialog = shell.dialog;
        this.closeButton = shell.closeButton;
        this.dismissAllButton = shell.dismissAllButton;
        this.list = shell.list;
        this.announcements = shell.announcements;
        this.disclosure = shell.disclosure;
        this.routingStatus = shell.routingStatus;
        this.toastContainer = shell.toastContainer;
        this.ownedDom = shell.ownedDom;
        this.onDestroy = options.onDestroy;
        this.onReadyTabs = options.onReadyTabs;
        this.actionsBlocked = this.readRoutingBlock();
        this.routingStatus.classList.toggle('hidden', !this.actionsBlocked);
        if (options.storageKey && options.store) {
            this.setContext(options.storageKey, options.store);
        }

        this.trigger.addEventListener('click', this.onTriggerClick);
        this.closeButton.addEventListener('click', this.onCloseClick);
        this.dismissAllButton.addEventListener('click', this.onDismissAllClick);
        this.overlay.addEventListener('click', this.onOverlayClick);

        this.observer =
            typeof MutationObserver === 'function'
                ? new MutationObserver((records) =>
                      this.consumeMutations(records),
                  )
                : null;
        this.observer?.observe(this.toastContainer, { childList: true });
        for (const child of Array.from(this.toastContainer.children)) {
            if (isToastElement(child)) this.importLegacyToast(child);
        }
        this.updateControls();
    }

    private readRoutingBlock(): boolean {
        try {
            return sessionStorage.getItem(ROUTING_BLOCK_STORAGE_KEY) === '1';
        } catch {
            return false;
        }
    }

    setActionsBlocked(blocked: boolean): void {
        if (this.destroyed) return;
        this.actionsBlocked = blocked;
        this.routingStatus.classList.toggle('hidden', !blocked);
        this.routingStatus.setAttribute('aria-hidden', String(!blocked));
        try {
            if (blocked) sessionStorage.setItem(ROUTING_BLOCK_STORAGE_KEY, '1');
            else sessionStorage.removeItem(ROUTING_BLOCK_STORAGE_KEY);
        } catch {
            // The live-page guard still works when session storage is blocked.
        }
        for (const entry of this.entries) {
            this.updatePopup(entry);
            this.updateRow(entry);
        }
    }

    getContextIdentity(): object | null {
        return this.context;
    }

    isCurrentContext(identity: object | null): boolean {
        return Boolean(
            identity &&
                identity === this.context &&
                this.context &&
                this.isSnapshotValid(this.context),
        );
    }

    captureNotifier():
        | ((message: string, options?: ToastOptions) => HTMLElement | undefined)
        | null {
        const context = this.context;
        if (!context || this.destroyed) return null;
        return (message, options = {}) => {
            if (this.destroyed || !this.isSnapshotValid(context))
                return undefined;
            if (this.context === context) return this.show(message, options);
            this.appendCapturedInformation(context, message, options);
            return undefined;
        };
    }

    private appendCapturedInformation(
        context: NotificationContext,
        message: string,
        options: ToastOptions,
    ): void {
        if (this.destroyed || !this.isSnapshotValid(context)) return;
        const type = normalizeType(options.type);
        const metadata: NotificationMetadata = {
            id: this.createEntryId(context),
            type,
            title: String(options.title || DEFAULT_TITLES[type]).slice(
                0,
                MAX_TITLE_PREVIEW,
            ),
            message: String(message ?? '').slice(0, MAX_MESSAGE_PREVIEW),
            timestamp: Date.now(),
        };
        context.snapshot.unshift(metadata);
        context.snapshot.splice(MAX_RECORDS);
        this.scheduleWrite(context);
    }

    endContext(): void {
        if (this.destroyed) return;
        const context = this.context;
        this.drainPendingMutationsForClear();
        if (!context) return;
        for (const entry of this.entries) {
            if (entry.context === context && !entry.expired) {
                this.expire(entry, false);
            }
        }
        this.readyGroup = null;
        this.syncSnapshot(context);
    }

    clearCurrentContext(): void {
        if (this.destroyed) return;
        const context = this.context;
        this.drainPendingMutationsForClear();
        for (const entry of [...this.entries])
            this.removeEntry(entry, false, false);
        for (const child of Array.from(this.toastContainer.children)) {
            if (!isToastElement(child)) continue;
            if (!this.nodeEntries.has(child)) this.nodeEntries.set(child, null);
            child.remove();
        }
        if (context && context.store.notifications === context.snapshot) {
            context.snapshot.length = 0;
            context.store.notifications = null;
            this.dirtyStores.delete(context.store);
        }
        this.context = null;
        this.readyGroup = null;
        this.renderHistory();
        this.updateControls();
    }

    setContext(storageKey: string, store: BackendStore): void {
        if (this.destroyed) return;
        const focusWasInRows = this.list.contains(document.activeElement);
        if (this.context) {
            this.syncSnapshot(this.context);
            for (const entry of this.entries) {
                this.cancelEntryWork(entry);
                entry.callback = null;
                entry.actionText = null;
                entry.readyMembers = null;
                entry.expired = true;
                entry.deadline = null;
                this.hidePopup(entry, false);
                entry.row?.remove();
                entry.row = null;
                entry.rowTitle = null;
                entry.rowMessage = null;
                entry.rowActions = null;
                entry.rowAction = null;
                entry.rowDismiss = null;
            }
            this.entries.length = 0;
            this.entriesById.clear();
            this.readyGroup = null;
        }

        let snapshot = store.notifications;
        let normalizedChanged = false;
        if (snapshot === null) {
            let raw: string | null = null;
            try {
                raw = localStorage.getItem(storageKey);
            } catch {
                // Storage may be blocked; the in-memory cache still works.
            }
            snapshot = parseStoredNotifications(raw);
            store.notifications = snapshot;
        } else {
            const normalized = normalizeMetadataList(snapshot);
            normalizedChanged = !this.sameMetadata(snapshot, normalized);
            snapshot.splice(0, snapshot.length, ...normalized);
        }

        const context: NotificationContext = { storageKey, store, snapshot };
        this.context = context;
        for (const metadata of snapshot) {
            const entry = this.makeStoredEntry(metadata, context);
            this.entries.push(entry);
            this.entriesById.set(entry.id, entry);
        }
        this.renderHistory();
        if (focusWasInRows && !this.dialog.contains(document.activeElement)) {
            this.closeButton.focus();
        }
        this.updateControls();
        if (normalizedChanged) this.scheduleWrite(context);
    }

    private sameMetadata(
        current: NotificationMetadata[],
        normalized: NotificationMetadata[],
    ): boolean {
        if (current.length !== normalized.length) return false;
        return current.every((value, index) => {
            const next = normalized[index];
            if (!next || typeof value !== 'object' || value === null)
                return false;
            const record = value as NotificationMetadata &
                Record<string, unknown>;
            const keys = Object.keys(record);
            return (
                keys.length === 5 &&
                record.id === next.id &&
                record.type === next.type &&
                record.title === next.title &&
                record.message === next.message &&
                record.timestamp === next.timestamp
            );
        });
    }

    private makeStoredEntry(
        metadata: NotificationMetadata,
        context: NotificationContext,
    ): NotificationEntry {
        return {
            id: metadata.id,
            title: metadata.title,
            message: metadata.message,
            type: metadata.type,
            timestamp: metadata.timestamp,
            context,
            legacy: false,
            expired: true,
            deadline: null,
            actionText: null,
            callback: null,
            popup: null,
            fadingPopup: null,
            timer: null,
            timerToken: 0,
            readyMembers: null,
            fadeTimer: null,
            fadeToken: 0,
            animation: null,
            row: null,
            rowTitle: null,
            rowMessage: null,
            rowActions: null,
            rowAction: null,
            rowDismiss: null,
        };
    }

    private createEntryId(context = this.context): string {
        let id = '';
        do {
            id = `notification-${Date.now()}-${++this.nextId}`;
        } while (
            this.entriesById.has(id) ||
            context?.snapshot.some((entry) => entry.id === id)
        );
        return id;
    }

    private isSnapshotValid(context: NotificationContext): boolean {
        if (context.store.notifications !== context.snapshot) return false;
        return (
            !context.store.registry ||
            backendStores.peek(context.store.profileId) === context.store
        );
    }

    private isContextLive(context: NotificationContext | null): boolean {
        return (
            context === null ||
            (context === this.context && this.isSnapshotValid(context))
        );
    }

    private metadataFor(entry: NotificationEntry): NotificationMetadata {
        return {
            id: entry.id,
            type: entry.type,
            title: entry.title.slice(0, MAX_TITLE_PREVIEW),
            message: entry.message.slice(0, MAX_MESSAGE_PREVIEW),
            timestamp: entry.timestamp,
        };
    }

    private syncSnapshot(context: NotificationContext | null): void {
        if (!context || !this.isSnapshotValid(context)) return;
        const metadata = this.entries
            .filter((entry) => entry.context === context)
            .slice(0, MAX_RECORDS)
            .map((entry) => this.metadataFor(entry));
        context.snapshot.splice(0, context.snapshot.length, ...metadata);
        this.scheduleWrite(context);
    }

    private scheduleWrite(context: NotificationContext): void {
        if (!this.isSnapshotValid(context)) return;
        for (const [store, pending] of this.dirtyStores) {
            if (!this.isSnapshotValid(pending)) this.dirtyStores.delete(store);
        }
        this.dirtyStores.delete(context.store);
        this.dirtyStores.set(context.store, context);
        while (this.dirtyStores.size > MAX_DIRTY_STORES) {
            const oldest = this.dirtyStores.keys().next().value;
            if (oldest === undefined) break;
            this.dirtyStores.delete(oldest);
        }
        if (this.writeTimer === null) {
            this.writeTimer = window.setTimeout(() => {
                this.flushPendingWrites();
            }, 0);
        }
        if (!this.pagehideListening) {
            window.addEventListener('pagehide', this.onPageHide);
            this.pagehideListening = true;
        }
    }

    private flushPendingWrites(): void {
        if (this.writeTimer !== null) clearTimeout(this.writeTimer);
        this.writeTimer = null;
        if (this.pagehideListening) {
            window.removeEventListener('pagehide', this.onPageHide);
            this.pagehideListening = false;
        }
        const pending = [...this.dirtyStores.values()];
        this.dirtyStores.clear();
        for (const context of pending) {
            if (!this.isSnapshotValid(context)) continue;
            const entries = context.snapshot
                .slice(0, MAX_RECORDS)
                .map((metadata) => normalizeMetadata(metadata))
                .filter(
                    (metadata): metadata is NotificationMetadata =>
                        metadata !== null,
                );
            try {
                localStorage.setItem(
                    context.storageKey,
                    JSON.stringify({ version: 1, entries }),
                );
            } catch {
                // Keep the in-memory snapshot; a future change may try again.
            }
        }
    }

    show(message: string, options: ToastOptions = {}): HTMLElement {
        const readyPaneId =
            typeof options.readyPaneId === 'string'
                ? options.readyPaneId.trim()
                : '';
        if (readyPaneId) return this.showReady(message, options, readyPaneId);
        return this.showOrdinary(message, options);
    }

    private showOrdinary(
        message: string,
        options: ToastOptions,
    ): HTMLDivElement {
        if (this.destroyed)
            throw new Error('NotificationManager has been destroyed');

        const type = normalizeType(options.type);
        const duration = normalizeDuration(options.duration);
        const title = options.title || DEFAULT_TITLES[type];
        const action = options.action;
        const actionText =
            action && typeof action.callback === 'function'
                ? String(action.text)
                : null;
        const entry: NotificationEntry = {
            id: this.createEntryId(),
            title: String(title),
            message: String(message ?? ''),
            type,
            timestamp: Date.now(),
            context: this.context,
            legacy: false,
            expired: false,
            deadline: duration > 0 ? Date.now() + duration : null,
            actionText,
            callback: actionText !== null && action ? action.callback : null,
            popup: null,
            fadingPopup: null,
            timer: null,
            timerToken: 0,
            readyMembers: null,
            fadeTimer: null,
            fadeToken: 0,
            animation: null,
            row: null,
            rowTitle: null,
            rowMessage: null,
            rowActions: null,
            rowAction: null,
            rowDismiss: null,
        };

        this.entries.unshift(entry);
        this.entriesById.set(entry.id, entry);
        const toast = this.createToast(entry);
        entry.popup = toast;
        this.nodeEntries.set(toast, entry);
        this.toastContainer.appendChild(toast);
        this.scheduleShow(entry, toast);
        if (entry.deadline !== null) this.armDeadline(entry);
        this.trimHistory();
        this.announce(entry);
        this.renderHistory();
        this.updateControls();
        return toast;
    }

    private showReady(
        message: string,
        options: ToastOptions,
        paneId: string,
    ): HTMLDivElement {
        let group = this.readyGroup;
        if (
            group &&
            (this.entriesById.get(group.id) !== group ||
                group.expired ||
                !group.popup ||
                group.popup.parentElement !== this.toastContainer ||
                (group.deadline !== null && Date.now() >= group.deadline))
        ) {
            if (this.entriesById.get(group.id) === group && !group.expired) {
                this.expire(group, true);
            }
            if (this.readyGroup === group) this.readyGroup = null;
            group = null;
        }

        const type = normalizeType(options.type);
        const action = options.action;
        const member: ReadyMember = {
            title: String(options.title || DEFAULT_TITLES[type]),
            message: String(message ?? ''),
            type,
            actionText:
                action && typeof action.callback === 'function'
                    ? String(action.text)
                    : null,
            callback:
                action && typeof action.callback === 'function'
                    ? action.callback
                    : null,
        };

        if (!group) {
            const toast = this.showOrdinary(message, {
                ...options,
                duration: READY_GROUP_DURATION,
            });
            const entry = this.nodeEntries.get(toast);
            if (!entry || this.entriesById.get(entry.id) !== entry)
                return toast;
            entry.readyMembers = new Map([[paneId, member]]);
            this.readyGroup = entry;
            return toast;
        }

        group.readyMembers ||= new Map();
        group.readyMembers.set(paneId, member);
        this.updateReadyPresentation(group);
        this.promote(group);
        this.restartDeadline(group, READY_GROUP_DURATION);
        this.announce(group);
        this.syncSnapshot(this.context);
        this.renderHistory();
        this.updateControls();
        return group.popup as HTMLDivElement;
    }

    private updateReadyPresentation(entry: NotificationEntry): void {
        const members = [...(entry.readyMembers?.values() || [])];
        if (members.length === 0) return;
        if (members.length === 1) {
            const member = members[0];
            if (!member) return;
            entry.title = member.title;
            entry.message = member.message;
            entry.type = member.type;
            entry.actionText = member.actionText;
            entry.callback = member.callback;
        } else {
            const latest = members[members.length - 1];
            if (latest) {
                entry.title = latest.title;
                entry.type = latest.type;
            }
            entry.message = `${members.length} tabs ready`;
            entry.actionText = this.onReadyTabs ? 'View tabs' : null;
            entry.callback = this.onReadyTabs || null;
        }
        this.updatePopup(entry);
        this.updateRow(entry);
    }

    private promote(entry: NotificationEntry): void {
        const index = this.entries.indexOf(entry);
        if (index > 0) {
            this.entries.splice(index, 1);
            this.entries.unshift(entry);
        }
        if (entry.popup?.parentElement === this.toastContainer) {
            this.toastContainer.appendChild(entry.popup);
        }
    }

    private restartDeadline(entry: NotificationEntry, duration: number): void {
        if (entry.timer !== null) clearTimeout(entry.timer);
        entry.timer = null;
        entry.deadline = Date.now() + duration;
        entry.expired = false;
        this.armDeadline(entry);
    }

    private armDeadline(entry: NotificationEntry): void {
        if (entry.deadline === null || this.entriesById.get(entry.id) !== entry)
            return;
        const token = ++entry.timerToken;
        const deadline = entry.deadline;
        entry.timer = window.setTimeout(
            () => {
                if (
                    entry.timerToken !== token ||
                    this.entriesById.get(entry.id) !== entry ||
                    entry.deadline !== deadline
                ) {
                    return;
                }
                entry.timer = null;
                const remaining = deadline - Date.now();
                if (remaining > 0) {
                    this.armDeadline(entry);
                    return;
                }
                this.expire(entry, true);
            },
            Math.max(0, deadline - Date.now()),
        );
    }

    removeReadyPane(paneId: string): void {
        const group = this.readyGroup;
        if (!group || this.entriesById.get(group.id) !== group) return;
        const members = group.readyMembers;
        if (!members?.delete(paneId)) return;
        if (members.size === 0) {
            group.readyMembers = null;
            group.callback = null;
            group.actionText = null;
            group.expired = true;
            if (group.timer !== null) clearTimeout(group.timer);
            group.timer = null;
            group.timerToken++;
            group.deadline = null;
            this.hidePopup(group, true);
            this.updateRow(group);
            this.updateControls();
            this.readyGroup = null;
            this.syncSnapshot(group.context);
            return;
        }
        this.updateReadyPresentation(group);
        this.syncSnapshot(group.context);
        this.renderHistory();
    }

    dismissToast(element: Element | null | undefined): void {
        if (!element || !(element instanceof HTMLElement)) return;
        let entry = this.nodeEntries.get(element);
        if (!this.nodeEntries.has(element)) {
            if (
                element.parentElement === this.toastContainer &&
                element.classList.contains('toast')
            ) {
                entry = this.importLegacyToast(element as HTMLDivElement);
            } else {
                return;
            }
        }
        if (!entry || this.entriesById.get(entry.id) !== entry) return;
        this.expire(entry, true);
    }

    open(): void {
        if (this.destroyed || this.opened) return;
        this.opener =
            document.activeElement instanceof HTMLElement &&
            document.activeElement !== document.body &&
            document.activeElement.isConnected
                ? document.activeElement
                : this.trigger;
        this.opened = true;
        this.overlay.classList.remove('hidden');
        this.overlay.setAttribute('aria-hidden', 'false');
        this.trigger.setAttribute('aria-expanded', 'true');
        this.renderHistory();
        document.addEventListener('keydown', this.onKeyDown, true);
        document.addEventListener('keyup', this.onOtherKey, true);
        document.addEventListener('keypress', this.onOtherKey, true);
        document.addEventListener('focusin', this.onFocusIn, true);
        this.closeButton.focus();
    }

    close({ restoreFocus = true }: { restoreFocus?: boolean } = {}): void {
        if (!this.opened) return;
        this.opened = false;
        this.overlay.classList.add('hidden');
        this.overlay.setAttribute('aria-hidden', 'true');
        this.trigger.setAttribute('aria-expanded', 'false');
        document.removeEventListener('keydown', this.onKeyDown, true);
        document.removeEventListener('keyup', this.onOtherKey, true);
        document.removeEventListener('keypress', this.onOtherKey, true);
        document.removeEventListener('focusin', this.onFocusIn, true);
        const opener = this.opener;
        this.opener = null;
        if (restoreFocus && opener?.isConnected) opener.focus();
    }

    dismissAll(): void {
        if (this.destroyed) return;
        this.drainPendingMutationsForClear();
        const focusWasInRows = this.list.contains(document.activeElement);
        for (const entry of [...this.entries])
            this.removeEntry(entry, false, false);
        for (const child of Array.from(this.toastContainer.children)) {
            if (!isToastElement(child)) continue;
            if (!this.nodeEntries.has(child)) this.nodeEntries.set(child, null);
            child.remove();
        }
        this.syncSnapshot(this.context);
        this.renderHistory();
        this.updateControls();
        if (focusWasInRows && this.opened) this.closeButton.focus();
    }

    destroy(): void {
        if (this.destroyed) return;
        this.drainPendingMutationsForClear();
        this.destroyed = true;
        this.close({ restoreFocus: false });
        this.observer?.disconnect();

        this.trigger.removeEventListener('click', this.onTriggerClick);
        this.closeButton.removeEventListener('click', this.onCloseClick);
        this.dismissAllButton.removeEventListener(
            'click',
            this.onDismissAllClick,
        );
        this.overlay.removeEventListener('click', this.onOverlayClick);

        this.flushPendingWrites();
        for (const entry of this.entries) {
            this.cancelEntryWork(entry);
            entry.callback = null;
            entry.actionText = null;
            entry.readyMembers = null;
            if (entry.popup) {
                this.nodeEntries.set(entry.popup, entry);
                if (!entry.legacy) entry.popup.remove();
                entry.popup = null;
            }
            if (entry.fadingPopup) {
                this.nodeEntries.set(entry.fadingPopup, entry);
                entry.fadingPopup.remove();
                entry.fadingPopup = null;
            }
            entry.row?.remove();
            entry.row = null;
            entry.rowTitle = null;
            entry.rowMessage = null;
            entry.rowActions = null;
            entry.rowAction = null;
            entry.rowDismiss = null;
        }
        this.emptyState?.remove();
        this.emptyState = null;
        this.entriesById.clear();
        this.readyGroup = null;
        this.dismissAllButton.disabled = true;
        for (const element of this.ownedDom.reverse()) {
            if (
                element === this.toastContainer &&
                element.childElementCount > 0
            ) {
                continue;
            }
            element.remove();
        }
        this.onDestroy?.();
    }

    activate(id: string): void {
        if (this.actionsBlocked) return;
        const entry = this.entriesById.get(id);
        if (!entry || entry.expired || !entry.callback) return;
        if (!this.isContextLive(entry.context)) {
            this.expire(entry, false);
            return;
        }
        if (entry.popup && entry.popup.parentElement !== this.toastContainer) {
            this.expire(entry, false);
            return;
        }
        if (entry.deadline !== null && Date.now() >= entry.deadline) {
            this.expire(entry, true);
            return;
        }

        const callback = entry.callback;
        entry.callback = null;
        entry.actionText = null;
        this.updateRow(entry);
        try {
            callback();
        } finally {
            this.removeEntry(entry);
        }
    }

    private createToast(entry: NotificationEntry): HTMLDivElement {
        const toast = document.createElement('div');
        toast.className = `toast toast-${entry.type}`;

        const icon = document.createElement('span');
        icon.className = 'toast-icon';
        icon.textContent = ICONS[entry.type];

        const body = document.createElement('div');
        body.className = 'toast-body';
        const title = document.createElement('div');
        title.className = 'toast-title';
        title.textContent = entry.title;
        const message = document.createElement('div');
        message.className = 'toast-message';
        message.textContent = entry.message;
        body.append(title, message);

        if (entry.actionText && entry.callback) {
            body.appendChild(this.createPopupActionButton(entry));
        }

        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.className = 'toast-close';
        closeButton.textContent = '×';
        closeButton.title = 'Dismiss';
        closeButton.setAttribute('aria-label', 'Dismiss notification');
        const id = entry.id;
        closeButton.addEventListener('click', (event) => {
            event.stopPropagation();
            const current = this.entriesById.get(id);
            if (current) this.expire(current, true);
        });

        toast.append(icon, body, closeButton);
        return toast;
    }

    private createPopupActionButton(
        entry: NotificationEntry,
    ): HTMLButtonElement {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'toast-action-btn';
        button.textContent = entry.actionText || '';
        button.style.marginTop = '6px';
        button.style.padding = '3px 8px';
        button.style.backgroundColor = 'var(--accent, #7c6af7)';
        button.style.color = '#ffffff';
        button.style.border = 'none';
        button.style.borderRadius = '4px';
        button.style.cursor = 'pointer';
        button.style.fontSize = '12px';
        button.style.fontWeight = 'bold';
        button.disabled = this.actionsBlocked;
        button.setAttribute('aria-disabled', String(this.actionsBlocked));
        const id = entry.id;
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            this.activate(id);
        });
        return button;
    }

    private updatePopup(entry: NotificationEntry): void {
        const popup = entry.popup;
        if (!popup) return;
        popup.classList.remove('toast-info', 'toast-error', 'toast-success');
        popup.classList.add(`toast-${entry.type}`);
        const icon = popup.querySelector('.toast-icon');
        const title = popup.querySelector('.toast-title');
        const message = popup.querySelector('.toast-message');
        if (icon) icon.textContent = ICONS[entry.type];
        if (title) title.textContent = entry.title;
        if (message) message.textContent = entry.message;

        const body = popup.querySelector('.toast-body');
        const actionButton =
            body?.querySelector<HTMLButtonElement>('.toast-action-btn');
        if (entry.actionText && entry.callback && !entry.expired) {
            if (actionButton) {
                actionButton.textContent = entry.actionText;
                actionButton.disabled = this.actionsBlocked;
                actionButton.setAttribute(
                    'aria-disabled',
                    String(this.actionsBlocked),
                );
            } else {
                body?.appendChild(this.createPopupActionButton(entry));
            }
        } else {
            actionButton?.remove();
        }
    }

    private scheduleShow(
        entry: NotificationEntry,
        toast: HTMLDivElement,
    ): void {
        const view = document.defaultView;
        if (!view) {
            toast.classList.add('show');
            return;
        }
        const show = (): void => {
            entry.animation = null;
            if (
                !this.destroyed &&
                this.entriesById.get(entry.id) === entry &&
                entry.popup === toast &&
                toast.parentElement === this.toastContainer
            ) {
                toast.classList.add('show');
            }
        };
        if (typeof view.requestAnimationFrame === 'function') {
            entry.animation = {
                id: view.requestAnimationFrame(show),
                kind: 'raf',
            };
        } else {
            entry.animation = {
                id: view.setTimeout(show, 0),
                kind: 'timeout',
            };
        }
    }

    private expire(entry: NotificationEntry, animate: boolean): void {
        if (this.entriesById.get(entry.id) !== entry || entry.expired) return;
        entry.expired = true;
        entry.deadline = null;
        entry.callback = null;
        entry.actionText = null;
        entry.readyMembers = null;
        if (this.readyGroup === entry) this.readyGroup = null;
        if (entry.timer !== null) clearTimeout(entry.timer);
        entry.timer = null;
        entry.timerToken++;
        this.hidePopup(entry, animate);
        this.updateRow(entry);
        this.updateControls();
    }

    private hidePopup(entry: NotificationEntry, animate: boolean): void {
        const popup = entry.popup;
        if (!popup) return;
        entry.popup = null;
        if (entry.animation) {
            if (entry.animation.kind === 'raf') {
                window.cancelAnimationFrame(entry.animation.id);
            } else {
                clearTimeout(entry.animation.id);
            }
            entry.animation = null;
        }
        if (!animate || !popup.isConnected) {
            this.nodeEntries.set(popup, entry);
            popup.remove();
            return;
        }

        entry.fadingPopup = popup;
        popup.classList.remove('show');
        const token = ++entry.fadeToken;
        entry.fadeTimer = window.setTimeout(() => {
            entry.fadeTimer = null;
            if (entry.fadeToken !== token || entry.fadingPopup !== popup)
                return;
            entry.fadingPopup = null;
            this.nodeEntries.set(popup, entry);
            popup.remove();
        }, 200);
    }

    private removeEntry(
        entry: NotificationEntry,
        render = true,
        writeSnapshot = true,
    ): void {
        if (this.entriesById.get(entry.id) !== entry) return;
        const index = this.entries.indexOf(entry);
        const focusedRow = entry.row?.contains(document.activeElement) ?? false;
        const nextEntry =
            this.entries[index + 1] || this.entries[index - 1] || null;
        this.cancelEntryWork(entry);
        entry.callback = null;
        entry.actionText = null;
        entry.readyMembers = null;
        if (this.readyGroup === entry) this.readyGroup = null;
        entry.expired = true;
        entry.deadline = null;
        this.entriesById.delete(entry.id);
        if (index >= 0) this.entries.splice(index, 1);
        for (const popup of [entry.popup, entry.fadingPopup]) {
            if (popup) {
                this.nodeEntries.set(popup, entry);
                popup.remove();
            }
        }
        entry.popup = null;
        entry.fadingPopup = null;
        entry.row?.remove();
        entry.row = null;
        entry.rowTitle = null;
        entry.rowMessage = null;
        entry.rowActions = null;
        entry.rowAction = null;
        entry.rowDismiss = null;

        if (focusedRow && this.opened) {
            const focusTarget = nextEntry?.rowDismiss || this.closeButton;
            focusTarget.focus();
        }
        if (writeSnapshot) this.syncSnapshot(entry.context);
        if (render) {
            this.renderHistory();
            this.updateControls();
        }
    }

    private cancelEntryWork(entry: NotificationEntry): void {
        entry.timerToken++;
        if (entry.timer !== null) clearTimeout(entry.timer);
        if (entry.fadeTimer !== null) clearTimeout(entry.fadeTimer);
        if (entry.animation) {
            if (entry.animation.kind === 'raf') {
                window.cancelAnimationFrame(entry.animation.id);
            } else {
                clearTimeout(entry.animation.id);
            }
        }
        entry.timer = null;
        entry.fadeTimer = null;
        entry.fadeToken++;
        entry.animation = null;
    }

    private trimHistory(): void {
        while (this.entries.length > MAX_RECORDS) {
            const oldest = this.entries[this.entries.length - 1];
            if (!oldest) break;
            this.removeEntry(oldest, false, false);
        }
        this.syncSnapshot(this.context);
        this.renderHistory();
        this.updateControls();
    }

    private importLegacyToast(toast: HTMLDivElement): NotificationEntry {
        const type: ToastType = toast.classList.contains('toast-error')
            ? 'error'
            : toast.classList.contains('toast-success')
              ? 'success'
              : 'info';
        const titleText = toast
            .querySelector('.toast-title')
            ?.textContent?.trim();
        const messageText = toast.querySelector('.toast-message')?.textContent;
        const entry = this.makeEntry({
            title: titleText || DEFAULT_TITLES[type],
            message: messageText ?? toast.textContent ?? '',
            type,
            popup: toast,
            legacy: true,
        });
        this.nodeEntries.set(toast, entry);
        this.entries.unshift(entry);
        this.entriesById.set(entry.id, entry);
        this.trimHistory();
        this.announce(entry);
        return entry;
    }

    private makeEntry(options: {
        title: string;
        message: string;
        type: ToastType;
        popup: HTMLDivElement;
        legacy: boolean;
    }): NotificationEntry {
        return {
            id: this.createEntryId(),
            title: options.title,
            message: options.message,
            type: options.type,
            timestamp: Date.now(),
            context: this.context,
            legacy: options.legacy,
            expired: false,
            deadline: null,
            actionText: null,
            callback: null,
            popup: options.popup,
            fadingPopup: null,
            timer: null,
            timerToken: 0,
            readyMembers: null,
            fadeTimer: null,
            fadeToken: 0,
            animation: null,
            row: null,
            rowTitle: null,
            rowMessage: null,
            rowActions: null,
            rowAction: null,
            rowDismiss: null,
        };
    }

    private consumeMutations(records: MutationRecord[]): void {
        if (this.destroyed) return;
        for (const record of records) {
            if (record.type !== 'childList') continue;
            for (const node of Array.from(record.removedNodes)) {
                if (!isToastElement(node)) continue;
                const entry = this.nodeEntries.get(node);
                if (
                    node.parentElement === this.toastContainer ||
                    !entry ||
                    this.entriesById.get(entry.id) !== entry ||
                    entry.popup !== node
                ) {
                    continue;
                }
                this.expire(entry, false);
            }
            for (const node of Array.from(record.addedNodes)) {
                if (
                    !isToastElement(node) ||
                    node.parentElement !== this.toastContainer
                ) {
                    continue;
                }
                if (this.nodeEntries.has(node)) {
                    const entry = this.nodeEntries.get(node);
                    if (
                        !entry ||
                        this.entriesById.get(entry.id) !== entry ||
                        entry.popup !== node
                    ) {
                        node.remove();
                    }
                    continue;
                }
                this.importLegacyToast(node);
            }
        }
    }

    private drainPendingMutationsForClear(): void {
        const records = this.observer?.takeRecords() || [];
        for (const record of records) {
            if (record.type !== 'childList') continue;
            for (const node of Array.from(record.addedNodes)) {
                if (
                    isToastElement(node) &&
                    node.parentElement !== this.toastContainer &&
                    !this.nodeEntries.has(node)
                ) {
                    this.nodeEntries.set(node, null);
                }
            }
        }
        this.consumeMutations(records);
    }

    private renderHistory(): void {
        if (!this.opened || this.destroyed) return;
        const focused =
            this.list.contains(document.activeElement) &&
            document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
        if (this.entries.length === 0) {
            for (const child of Array.from(this.list.children)) child.remove();
            this.emptyState = document.createElement('p');
            this.emptyState.className = 'notifications-empty';
            this.emptyState.textContent = 'No notifications yet.';
            this.list.appendChild(this.emptyState);
            return;
        }
        this.emptyState?.remove();
        this.emptyState = null;
        for (let index = 0; index < this.entries.length; index += 1) {
            const entry = this.entries[index];
            if (!entry) continue;
            const row = this.ensureRow(entry);
            this.updateRow(entry);
            const current = this.list.children[index] || null;
            if (current !== row) this.list.insertBefore(row, current);
        }
        if (focused?.isConnected && document.activeElement !== focused) {
            focused.focus({ preventScroll: true });
        }
    }

    private ensureRow(entry: NotificationEntry): HTMLElement {
        if (entry.row) return entry.row;
        const row = document.createElement('article');
        row.className = `notification-item notification-item-${entry.type}`;
        row.dataset.notificationId = entry.id;

        const content = document.createElement('div');
        content.className = 'notification-item-content';
        const title = document.createElement('h4');
        title.className = 'notification-item-title';
        const message = document.createElement('p');
        message.className = 'notification-item-message';
        content.append(title, message);

        const controls = document.createElement('div');
        controls.className = 'notification-item-controls';
        const actions = document.createElement('div');
        actions.className = 'notification-item-actions';
        const dismiss = makeButton(
            document,
            '',
            'btn btn-secondary notification-item-dismiss',
            'Dismiss',
        );
        const id = entry.id;
        dismiss.addEventListener('click', (event) => {
            event.stopPropagation();
            this.removeEntryById(id);
        });
        controls.append(actions, dismiss);
        row.append(content, controls);
        entry.row = row;
        entry.rowTitle = title;
        entry.rowMessage = message;
        entry.rowActions = actions;
        entry.rowDismiss = dismiss;
        return row;
    }

    private updateRow(entry: NotificationEntry): void {
        const row = entry.row;
        if (!row) return;
        if (entry.rowTitle) entry.rowTitle.textContent = entry.title;
        if (entry.rowMessage) entry.rowMessage.textContent = entry.message;
        const canAct =
            !entry.expired &&
            entry.callback !== null &&
            entry.actionText !== null;
        if (canAct && !entry.rowAction) {
            const actionButton = makeButton(
                document,
                '',
                'btn btn-primary notification-item-action',
                entry.actionText || '',
            );
            actionButton.disabled = this.actionsBlocked;
            actionButton.setAttribute(
                'aria-disabled',
                String(this.actionsBlocked),
            );
            const id = entry.id;
            actionButton.addEventListener('click', (event) => {
                event.stopPropagation();
                this.activate(id);
            });
            entry.rowActions?.appendChild(actionButton);
            entry.rowAction = actionButton;
        } else if (canAct && entry.rowAction) {
            entry.rowAction.textContent = entry.actionText || '';
            entry.rowAction.disabled = this.actionsBlocked;
            entry.rowAction.setAttribute(
                'aria-disabled',
                String(this.actionsBlocked),
            );
        } else if (!canAct && entry.rowAction) {
            const hadFocus = document.activeElement === entry.rowAction;
            entry.rowAction.remove();
            entry.rowAction = null;
            if (hadFocus && this.opened) {
                (entry.rowDismiss || this.closeButton).focus();
            }
        }
    }

    private removeEntryById(id: string): void {
        const entry = this.entriesById.get(id);
        if (entry) this.removeEntry(entry);
    }

    private updateControls(): void {
        this.dismissAllButton.disabled = this.entries.length === 0;
    }

    private announce(entry: NotificationEntry): void {
        this.announcements.textContent = `${entry.title}. ${entry.message}`;
    }

    private trapTab(event: KeyboardEvent): void {
        const focusable = Array.from(
            this.dialog.querySelectorAll<HTMLElement>(
                'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ),
        ).filter((element) => !element.closest('.hidden'));
        if (focusable.length === 0) {
            event.preventDefault();
            this.dialog.focus();
            return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (
            event.shiftKey &&
            (active === first || !this.dialog.contains(active))
        ) {
            event.preventDefault();
            last?.focus();
        } else if (
            !event.shiftKey &&
            (active === last || !this.dialog.contains(active))
        ) {
            event.preventDefault();
            first?.focus();
        }
    }
}
