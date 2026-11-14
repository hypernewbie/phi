// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { DiffController } from '../web/diff.js';

// These caches are written by a previous page load and by other tabs, so the
// reader treats every stored field as untrusted. A record that fails the shape
// check is dropped; the rest of the cache keeps working.

beforeEach(() => {
    localStorage.clear();
});

const target = () => ({
    root: '/work',
    head: 'abc123',
    branch: 'main',
    remote: 'origin',
    remote_ref: 'refs/heads/main',
    remote_token: 'tok',
});
const info = (over = {}) => ({
    can_pull_push: true,
    target: target(),
    ...over,
});
const record = (over = {}) => ({
    version: 1,
    id: 'r1',
    owner: 'tab-1',
    action: 'pull',
    target: target(),
    phase: 'confirmed',
    createdAt: 1,
    status: 'done',
    ...over,
});
const fileEntry = (over = {}) => ({
    path: 'a.txt',
    index: ' ',
    worktree: 'M',
    ...over,
});

const readInfo = (payload) => {
    localStorage.setItem('info-key', JSON.stringify(payload));
    const self = { gitManageMemory: new Map() };
    return DiffController.prototype.readGitManageInfo.call(self, 'info-key');
};

const readFiles = (payload) => {
    localStorage.setItem('ctx:files', JSON.stringify(payload));
    const self = { gitFilesMemory: new Map() };
    return DiffController.prototype.readCachedGitFiles.call(self, {
        infoKey: 'ctx',
    });
};

const readAction = (payload) => {
    if (payload !== undefined)
        localStorage.setItem('phi_git_manage_v1:x', JSON.stringify(payload));
    const self = {
        gitManageMemory: new Map(),
        gitManageContextKey: 'ctx',
    };
    return DiffController.prototype.readGitManageAction.call(
        self,
        'phi_git_manage_v1:x',
    );
};

describe('git manage info cache', () => {
    it('accepts a complete target', () => {
        expect(readInfo(info())).toMatchObject({ can_pull_push: true });
    });

    it('normalizes the not-a-repository sentinel', () => {
        expect(readInfo({ notGitRepo: true })).toEqual({
            notGitRepo: true,
            can_pull_push: false,
            has_staged: false,
            index_token: '',
            can_commit: false,
            commit_reason: '',
        });
    });

    it('accepts the sentinel beside unrelated junk', () => {
        expect(readInfo({ notGitRepo: true, can_pull_push: 'later' })).toEqual(
            expect.objectContaining({ notGitRepo: true }),
        );
    });

    const rejected = {
        null: null,
        'a bare boolean': true,
        'a missing can_pull_push': { target: target() },
        'a non-boolean can_pull_push': info({ can_pull_push: 'yes' }),
        'a missing target': { can_pull_push: true },
        'a target missing a field': info({
            target: { ...target(), remote_token: undefined },
        }),
        'a non-string target field': info({
            target: { ...target(), branch: 7 },
        }),
        'a non-string reason': info({ reason: 7 }),
        'a non-boolean has_staged': info({ has_staged: 'yes' }),
        'a non-string index_token': info({ index_token: 7 }),
        'a non-boolean can_commit': info({ can_commit: 1 }),
        'a non-boolean can_stage': info({ can_stage: 'no' }),
    };
    for (const [name, payload] of Object.entries(rejected)) {
        it(`returns null for ${name}`, () => {
            expect(readInfo(payload)).toBeNull();
        });
    }

    it('treats a malformed notGitRepo value as the regular shape', () => {
        expect(readInfo({ notGitRepo: 'yes' })).toBeNull();
    });
});

describe('cached git file list', () => {
    it('keeps well-formed entries and drops the rest', () => {
        expect(
            readFiles({
                files: [
                    fileEntry({ path: 'a' }),
                    fileEntry({ path: 7 }),
                    null,
                    fileEntry({ path: 'b' }),
                ],
                truncated: true,
            }),
        ).toEqual({
            files: [fileEntry({ path: 'a' }), fileEntry({ path: 'b' })],
            truncated: true,
        });
    });

    it('only reports truncation for a literal true', () => {
        expect(
            readFiles({ files: [fileEntry()], truncated: 'yes' })?.truncated,
        ).toBe(false);
    });

    it('reads the older bare array cache', () => {
        expect(readFiles([fileEntry({ path: 'old' })])).toEqual({
            files: [fileEntry({ path: 'old' })],
            truncated: false,
        });
    });

    it('rejects a container without a file list', () => {
        expect(readFiles({ truncated: true })).toBeNull();
        expect(readFiles(null)).toBeNull();
        expect(readFiles('nope')).toBeNull();
    });
});

describe('git manage action records', () => {
    it('accepts a stored record', () => {
        expect(readAction(record())?.record).toMatchObject({
            id: 'r1',
            action: 'pull',
        });
    });

    it('accepts an empty id, which only has to be a string', () => {
        expect(readAction(record({ id: '' }))?.record.id).toBe('');
    });

    it('requires a message and a 64-hex index token for a commit', () => {
        const commit = {
            action: 'commit',
            message: 'ship it',
            indexToken: 'a'.repeat(64),
        };
        expect(readAction(record(commit))?.record.action).toBe('commit');
        expect(readAction(record({ action: 'commit' }))).toBeNull();
        expect(
            readAction(record({ ...commit, indexToken: 'a'.repeat(63) })),
        ).toBeNull();
        expect(
            readAction(record({ ...commit, indexToken: 'z'.repeat(64) })),
        ).toBeNull();
        expect(
            readAction(record({ ...commit, indexToken: 'A'.repeat(64) })),
        ).not.toBeNull();
    });

    const rejected = {
        'a wrong version': record({ version: 2 }),
        'a non-string id': record({ id: 7 }),
        'a missing owner': record({ owner: undefined }),
        'an unknown action': record({ action: 'reset' }),
        'an unknown phase': record({ phase: 'exploded' }),
        'a missing target': record({ target: undefined }),
        'a non-numeric createdAt': record({ createdAt: '1' }),
        'a missing status': record({ status: undefined }),
        'a dismissed record': record({ phase: 'dismissed' }),
    };
    for (const [name, payload] of Object.entries(rejected)) {
        it(`drops ${name}`, () => {
            expect(readAction(payload)).toBeNull();
        });
    }

    it('ignores a corrupt record and keeps the readable one', () => {
        localStorage.setItem('phi_git_manage_v1:bad', '{not json');
        localStorage.setItem(
            'phi_git_manage_v1:good',
            JSON.stringify(record({ id: 'good' })),
        );
        const self = {
            gitManageMemory: new Map(),
            gitManageContextKey: 'ctx',
        };
        const found = DiffController.prototype.readGitManageAction.call(
            self,
            'phi_git_manage_v1:',
        );
        expect(found?.record.id).toBe('good');
    });
});

describe('git view cache', () => {
    const read = (payload, wanted = {}) => {
        const context = { key: 'ctx' };
        const self = Object.assign(Object.create(DiffController.prototype), {
            gitViewMemory: new Map(),
        });
        const key = self.gitViewCacheKey(context, 'root', 'view', 'sel');
        localStorage.setItem(key, JSON.stringify(payload));
        return self.readGitViewCache(
            context,
            wanted.root ?? 'root',
            wanted.view ?? 'view',
            wanted.selection ?? 'sel',
        );
    };
    const view = (over = {}) => ({
        version: 1,
        root: 'root',
        view: 'view',
        selection: 'sel',
        text: 'diff',
        head: 'abc',
        branch: 'main',
        updatedAt: 1,
        ...over,
    });

    it('accepts a matching entry', () => {
        expect(read(view())).toMatchObject({ text: 'diff' });
    });

    it('rejects a version or a field of the wrong type', () => {
        for (const payload of [
            view({ version: 2 }),
            view({ text: 7 }),
            view({ head: null }),
            view({ branch: 7 }),
            view({ updatedAt: '1' }),
            null,
            [],
            'nope',
        ]) {
            expect(read(payload), JSON.stringify(payload)).toBeNull();
        }
    });

    it('rejects an entry stored for another root, view or selection', () => {
        expect(read(view(), { root: 'other' })).toBeNull();
        expect(read(view(), { view: 'other' })).toBeNull();
        expect(read(view(), { selection: 'other' })).toBeNull();
    });
});
