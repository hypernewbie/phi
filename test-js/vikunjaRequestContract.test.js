// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupDomHarness, mockFetch } from './_dom.js';
import { KanbanManager } from '../web/kanban.js';

// Every request phi sends to Vikunja, validated against the vendored swagger.
//
// Why this file exists: phi has shipped the same class of bug repeatedly —
// a request that is malformed in a way only the live Vikunja server rejects,
// answered with an opaque 400 ("Invalid model provided.") that says nothing
// about which field or id was wrong. Previous fixes (POST-vs-PUT for create,
// the CREATE/UPDATE/MOVE swagger alignment) each fixed one call site by hand.
//
// vikunjaContract.test.js pins the endpoints phi is *allowed* to call. This
// file pins what phi *actually sends* when its real methods run: it drives
// every mutating method and asserts each captured request against the
// swagger. A new call site with a bad path, a misspelled body field, a
// wrong-typed value, or an unresolved id fails here rather than in a browser.

setupDomHarness();

const __dirname = dirname(fileURLToPath(import.meta.url));
const swagger = JSON.parse(
    readFileSync(resolve(__dirname, '..', 'testdata', 'vikunja_swagger.json'), 'utf8')
);

// ---------------------------------------------------------------------------
// Swagger validation helpers
// ---------------------------------------------------------------------------

// Match a concrete request path against a templated swagger path. Literal
// segments ("tasks", "buckets") must match exactly; "{...}" matches one
// segment. This is what catches a typo'd or restructured endpoint.
function matchSwaggerPath(concrete) {
    const actual = concrete.split('/').filter(Boolean);
    return Object.keys(swagger.paths).find((template) => {
        const parts = template.split('/').filter(Boolean);
        if (parts.length !== actual.length) return false;
        return parts.every((p, i) => (p.startsWith('{') && p.endsWith('}')) || p === actual[i]);
    });
}

function swaggerTypeOk(schema, value) {
    // Go treats a JSON null as a no-op for scalars, so it is not a contract
    // break on its own; assertNoUnresolvedIds covers the ids that matter.
    if (value === null) return true;
    switch (schema.type) {
        case 'integer': return Number.isInteger(value);
        case 'number': return typeof value === 'number' && Number.isFinite(value);
        case 'string': return typeof value === 'string';
        case 'boolean': return typeof value === 'boolean';
        case 'array': return Array.isArray(value);
        case 'object': return typeof value === 'object';
        default: return true;
    }
}

function resolveBodySchema(op) {
    const param = (op.parameters || []).find((p) => p.in === 'body');
    if (!param || !param.schema) return null;
    const ref = param.schema.$ref;
    if (!ref) return param.schema;
    return swagger.definitions[ref.replace('#/definitions/', '')] || null;
}

// Turn a captured fetch() call into the upstream Vikunja request.
function decodeRequest([url, opts]) {
    const proxied = decodeURIComponent(url.split('url=')[1]);
    const path = proxied.replace(/^.*\/api\/v1/, '').split('?')[0];
    return {
        path,
        method: (opts.method || 'GET').toUpperCase(),
        body: opts.body ? JSON.parse(opts.body) : null,
        raw: proxied,
    };
}

// An id that never resolved shows up as these literals inside the path. This
// is the exact shape of the "Invalid model provided." bug: parseInt(null, 10)
// is NaN, and `/projects/${NaN}/tasks` stringifies to "/projects/NaN/tasks".
function assertNoUnresolvedIds(req) {
    for (const segment of req.path.split('/')) {
        expect(
            ['NaN', 'undefined', 'null', ''].includes(segment) && segment !== '',
            `unresolved id "${segment}" in ${req.method} ${req.path}`
        ).toBe(false);
    }
}

function assertMatchesSwagger(req) {
    assertNoUnresolvedIds(req);

    const template = matchSwaggerPath(req.path);
    expect(template, `no Vikunja endpoint matches ${req.method} ${req.path}`).toBeTruthy();

    const op = swagger.paths[template][req.method.toLowerCase()];
    expect(op, `Vikunja does not accept ${req.method} on ${template}`).toBeTruthy();

    if (!req.body) return;

    const schema = resolveBodySchema(op);
    expect(schema, `${req.method} ${template} takes no body but phi sent one`).toBeTruthy();

    for (const [key, value] of Object.entries(req.body)) {
        const prop = schema.properties[key];
        expect(prop, `"${key}" is not a field of the body model for ${req.method} ${template}`)
            .toBeTruthy();
        expect(
            swaggerTypeOk(prop, value),
            `"${key}" should be ${prop.type} for ${req.method} ${template}, got ${JSON.stringify(value)}`
        ).toBe(true);
    }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function manager({ projectId = 9, viewId = 5 } = {}) {
    sessionStorage.setItem('vikunja_token', 'tok');
    localStorage.setItem('vikunja_url', 'http://vik.local');
    const c = Object.create(KanbanManager.prototype);
    c.app = { showToast: vi.fn() };
    c.currentProjectId = projectId;
    c.currentViewId = viewId;
    c.buckets = [{ id: 10, title: 'Todo' }, { id: 20, title: 'Done' }];
    c.taskCache = {
        1: { id: 1, title: 'A', project_id: projectId, bucket_id: 10, labels: [], assignees: [] },
    };
    c.loadAndRenderBoard = vi.fn(async () => {});
    return c;
}

function requests() {
    return fetch.mock.calls.map(decodeRequest);
}

beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
});

// ---------------------------------------------------------------------------
// Every mutating call site, driven through its real method.
// ---------------------------------------------------------------------------

const MUTATIONS = [
    {
        name: 'createTask',
        run: (c) => c.createTask(10, 'Write the thing'),
        reply: { ok: true, json: { id: 77 } },
    },
    {
        name: 'createSubtask',
        run: (c) => c.createSubtask({ id: 1, project_id: 9, bucket_id: 10 }, 'Child'),
        reply: { ok: true, json: { id: 78 } },
    },
    {
        name: 'setTaskDone',
        run: (c) => c.setTaskDone(c.taskCache[1], true),
        reply: { ok: true, json: { id: 1, done: true } },
    },
    {
        name: 'saveTaskDetail',
        run: (c) => c.saveTaskDetail(
            c.taskCache[1],
            { title: 'Renamed', priority: 3, done: false, description: '<p>hi</p>', due_date: null },
            document.createElement('div'),
            document.createElement('div')
        ),
        reply: { ok: true, json: { id: 1 } },
    },
    {
        name: 'deleteTask',
        run: (c) => c.deleteTask('1', null),
        reply: { ok: true, status: 204 },
    },
    {
        name: 'createBucket',
        run: (c) => c.createBucket('In Review', null),
        reply: { ok: true, json: { id: 30 } },
    },
    {
        name: 'updateBucket',
        run: (c) => c.updateBucket('10', 'Todo (renamed)', null),
        reply: { ok: true, json: { id: 10 } },
    },
    {
        name: 'deleteBucket',
        run: (c) => c.deleteBucket('20', null),
        reply: { ok: true, status: 204 },
    },
    {
        name: 'addLabelToTask',
        run: (c) => c.addLabelToTask('1', 4),
        reply: { ok: true, json: { id: 4 } },
    },
    {
        name: 'removeLabelFromTask',
        run: (c) => c.removeLabelFromTask('1', 4),
        reply: { ok: true, status: 204 },
    },
    {
        name: 'moveTask',
        run: (c) => c.moveTask('1', '20'),
        reply: { ok: true, status: 200, json: {} },
    },
];

describe('every phi -> Vikunja mutation matches the vendored swagger', () => {
    for (const mutation of MUTATIONS) {
        it(`${mutation.name} sends a request Vikunja accepts`, async () => {
            const c = manager();
            mockFetch(() => mutation.reply);

            await mutation.run(c);

            const sent = requests();
            expect(sent.length).toBeGreaterThan(0);
            for (const req of sent) assertMatchesSwagger(req);
        });
    }

    it('covers every method that talks to Vikunja', () => {
        // A new call site added without a contract case is the exact hole this
        // file exists to close, so derive the surface from the code instead of
        // trusting the list above to stay complete. Any method whose body
        // reaches apiPut/apiPost/apiDelete mutates upstream state and needs a
        // case here; apiGet is excluded because reads carry no body.
        const mutating = Object.getOwnPropertyNames(KanbanManager.prototype).filter((name) => {
            const fn = KanbanManager.prototype[name];
            // The constructor stringifies to the whole class body, so it
            // matches every call site in the file rather than its own.
            if (typeof fn !== 'function' || name === 'constructor' || name.startsWith('api')) {
                return false;
            }
            return /this\.api(Put|Post|Delete)\(/.test(Function.prototype.toString.call(fn));
        });
        expect(mutating.length).toBeGreaterThan(0);

        const covered = new Set(MUTATIONS.map((m) => m.name));
        const uncovered = mutating.filter((name) => !covered.has(name));
        expect(uncovered, `add a MUTATIONS case for: ${uncovered.join(', ')}`).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// The specific regression: an unresolved project id.
// ---------------------------------------------------------------------------

describe('unresolved ids never reach the network', () => {
    it('createTask uses the resolved project, not raw localStorage', async () => {
        // The board falls back to the first project when localStorage holds no
        // selection, and localStorage is per-origin — so on a host where the
        // user never touched the project dropdown the key is simply absent.
        // Reading it directly here produced /projects/NaN/tasks, which is why
        // the same phi build worked on one origin and failed on another.
        const c = manager({ projectId: 9 });
        localStorage.removeItem('vikunja_selected_project');
        mockFetch(() => ({ ok: true, json: { id: 77 } }));

        await c.createTask(10, 'Task on a fresh origin');

        const [req] = requests();
        expect(req.path).toBe('/projects/9/tasks');
        expect(req.method).toBe('PUT');
        expect(req.body).toEqual({ title: 'Task on a fresh origin', project_id: 9, bucket_id: 10 });
        assertMatchesSwagger(req);
    });

    it('createTask refuses to fire before the board resolved a project', async () => {
        const c = manager();
        c.currentProjectId = null;
        mockFetch(() => ({ ok: true, json: {} }));

        await expect(c.createTask(10, 'Too early')).rejects.toThrow(/project not loaded/i);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('the guard rejects a NaN path instead of letting Vikunja answer 400', async () => {
        const c = manager();
        mockFetch(() => ({ ok: true, json: {} }));

        await expect(c.apiPut(`/projects/${parseInt(null, 10)}/tasks`, { title: 'x' }))
            .rejects.toThrow(/Unresolved id "NaN"/);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('the guard rejects a non-finite id in the payload', async () => {
        const c = manager();
        mockFetch(() => ({ ok: true, json: {} }));

        await expect(c.apiPut('/projects/9/tasks', { title: 'x', bucket_id: NaN }))
            .rejects.toThrow(/Unresolved id in Vikunja payload field "bucket_id"/);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('a bucket with no usable id is omitted rather than sent as NaN', async () => {
        const c = manager();
        mockFetch(() => ({ ok: true, json: { id: 77 } }));

        await c.createTask(undefined, 'No bucket');

        const [req] = requests();
        expect(req.body).toEqual({ title: 'No bucket', project_id: 9 });
        assertMatchesSwagger(req);
    });
});

// ---------------------------------------------------------------------------
// The validator has to be able to fail, or it proves nothing.
// ---------------------------------------------------------------------------

describe('the contract validator itself', () => {
    it('rejects an unknown endpoint', () => {
        expect(() => assertMatchesSwagger({ method: 'PUT', path: '/projects/9/taskz', body: null }))
            .toThrow();
    });

    it('rejects the wrong method on a real endpoint', () => {
        // POST-for-create is the original bug this repo already fixed once.
        expect(() => assertMatchesSwagger({ method: 'POST', path: '/projects/9/tasks', body: null }))
            .toThrow();
    });

    it('rejects a body field that is not on the model', () => {
        expect(() => assertMatchesSwagger({
            method: 'PUT', path: '/projects/9/tasks', body: { titel: 'typo' },
        })).toThrow();
    });

    it('rejects a body field with the wrong type', () => {
        expect(() => assertMatchesSwagger({
            method: 'PUT', path: '/projects/9/tasks', body: { title: 'ok', bucket_id: 'ten' },
        })).toThrow();
    });

    it('rejects an unresolved id in the path', () => {
        expect(() => assertMatchesSwagger({
            method: 'PUT', path: '/projects/NaN/tasks', body: { title: 'ok' },
        })).toThrow();
    });
});
