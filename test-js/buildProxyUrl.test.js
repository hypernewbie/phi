import { describe, it, expect } from 'vitest';
import { buildProxyUrl } from '../web/util.js';

// buildProxyUrl composes the local /api/proxy?url= URL for coordinator calls.

describe('buildProxyUrl', () => {
    it('joins coordinator base and endpoint, URL-encoded', () => {
        expect(buildProxyUrl('http://localhost:7070', '/api/messages'))
            .toBe('/api/proxy?url=' + encodeURIComponent('http://localhost:7070/api/messages'));
    });

    it('strips exactly one trailing slash off the coordinator base', () => {
        expect(buildProxyUrl('http://host:7070/', '/x'))
            .toBe('/api/proxy?url=' + encodeURIComponent('http://host:7070/x'));
    });

    it('only strips a single trailing slash', () => {
        expect(buildProxyUrl('http://host//', '/x'))
            .toBe('/api/proxy?url=' + encodeURIComponent('http://host//x'));
    });

    it('encodes query params in the endpoint', () => {
        const url = buildProxyUrl('http://host', '/search?q=a b&n=1');
        expect(url).toBe('/api/proxy?url=' + encodeURIComponent('http://host/search?q=a b&n=1'));
        // the '&' and space must be percent-encoded inside the single param
        expect(url).not.toContain('&n=1');
        expect(url).toContain('%26n%3D1');
    });
});
