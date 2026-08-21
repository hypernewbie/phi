// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { loadPersisted, savePersisted } from '../web/chat-pi/persist.js';

describe('persist', () => {
    beforeEach(() => localStorage.clear());
    it('round-trips', () => {
        savePersisted('a', [{ role: 'user', content: 'hi' }]);
        expect(loadPersisted('a')).toEqual([{ role: 'user', content: 'hi' }]);
    });
    it('rejects wrong schema and corruption', () => {
        localStorage.setItem(
            'chat-pi:a',
            '{"schema":0,"sid":"a","messages":[]}',
        );
        expect(loadPersisted('a')).toBeNull();
        localStorage.setItem('chat-pi:a', '{bad');
        expect(loadPersisted('a')).toBeNull();
    });
    it('tolerates quota errors', () => {
        const orig = Storage.prototype.setItem;
        Storage.prototype.setItem = () => {
            throw new Error('quota');
        };
        expect(() =>
            savePersisted('a', [{ role: 'user', content: 'x' }]),
        ).not.toThrow();
        Storage.prototype.setItem = orig;
    });
});
