// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Schema lock-in: load the REAL Vikunja swagger.json (vendored from
// https://raw.githubusercontent.com/go-vikunja/vikunja/main/pkg/swagger/swagger.json)
// and verify that the methods/paths our kanban code uses match the contract.
// This catches drift if Vikunja ever renames an endpoint. To refresh the
// vendored copy: curl the URL above to testdata/vikunja_swagger.json.

const __dirname = dirname(fileURLToPath(import.meta.url));
const swagger = JSON.parse(
    readFileSync(
        resolve(__dirname, '..', 'testdata', 'vikunja_swagger.json'),
        'utf8',
    ),
);

// Helper: {method, path} -> Vikunja op or undefined.
function vikOp(method, path) {
    const ops = swagger.paths[path] || {};
    return ops[method.toLowerCase()];
}

describe('Vikunja swagger contract (locked-in)', () => {
    it('CREATE task is PUT /projects/{id}/tasks', () => {
        expect(vikOp('PUT', '/projects/{id}/tasks')).toBeTruthy();
        expect(vikOp('PUT', '/projects/{id}/tasks').summary).toMatch(/Create/i);
        // POST should NOT be valid for create — this is the bug that bit us.
        expect(vikOp('POST', '/projects/{id}/tasks')).toBeUndefined();
    });

    it('UPDATE task is POST /tasks/{id}', () => {
        const op = vikOp('POST', '/tasks/{id}');
        expect(op).toBeTruthy();
        expect(op.summary).toMatch(/Update/i);
    });

    it('There is a dedicated bucket-move endpoint', () => {
        const op = vikOp(
            'POST',
            '/projects/{project}/views/{view}/buckets/{bucket}/tasks',
        );
        expect(op).toBeTruthy();
        expect(op.summary).toMatch(/Update a task bucket/i);
        // body schema accepts { task_id }
        const body = (op.parameters || []).find((p) => p.in === 'body');
        expect(body && body.name).toBe('taskBucket');
    });

    it('models.Task exists and has bucket_id + project_id + title', () => {
        const t = swagger.definitions['models.Task'];
        expect(t).toBeTruthy();
        expect(t.properties.title).toBeTruthy();
        expect(t.properties.project_id).toBeTruthy();
        expect(t.properties.bucket_id).toBeTruthy();
    });

    it('supports native subtask relations and expanded view tasks', () => {
        const relation = vikOp('PUT', '/tasks/{taskID}/relations');
        expect(relation).toBeTruthy();
        expect(relation.summary).toMatch(/relation/i);
        const body = (relation.parameters || []).find((p) => p.in === 'body');
        expect(body && body.schema.$ref).toBe(
            '#/definitions/models.TaskRelation',
        );
        expect(swagger.definitions['models.RelationKind'].enum).toContain(
            'subtask',
        );

        const tasks = vikOp('GET', '/projects/{id}/views/{view}/tasks');
        const expand = (tasks.parameters || []).find(
            (p) => p.name === 'expand',
        );
        expect(expand).toBeTruthy();
        expect(expand.description).toMatch(/subtasks/i);
        expect(
            swagger.definitions['models.Task'].properties.related_tasks,
        ).toBeTruthy();
        expect(
            swagger.definitions['models.Task'].properties.created,
        ).toBeTruthy();
        expect(
            swagger.definitions['models.Task'].properties.done_at,
        ).toBeTruthy();
    });

    it('Vendor file is actually Vikunja swagger (sanity)', () => {
        expect(swagger.info && swagger.info.title).toMatch(/vikunja/i);
        expect(swagger.swagger).toMatch(/^2\./); // Swagger 2.0
    });
});
