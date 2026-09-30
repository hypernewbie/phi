// @vitest-environment jsdom
/**
 * VS Code launch URI builder tests.
 *
 * No browser API is needed here — builders are pure. The node environment
 * keeps these tests cheap and lets the same fixtures drive Plan 1
 * (local-only) and Plan 2 (Remote SSH) cases in one file.
 *
 * Real VS Code launch isn't exercised; the browser only needs the URI to
 * be correct. Manual browser verification with an installed editor is a
 * separate gate documented in VSCODE_PLAN1.md §10.
 */
import { describe, it, expect } from 'vitest';
import {
    buildVSCodeURI,
    buildVSCodeRemoteURI,
    isWindowsDrivePath,
    normalizeHostname,
    splitPathSegments,
    isVSCodeLaunchUnsupported,
} from '../web/vscode.js';

// VSCodeRemoteTarget is a TypeScript-only export; in the .js test we
// just construct plain objects of the right shape.

// ---------------------------------------------------------------------------
// Path classification helpers
// ---------------------------------------------------------------------------

describe('isWindowsDrivePath', () => {
    it('matches C:, D:, and lowercase variants', () => {
        expect(isWindowsDrivePath('C:/foo')).toBe(true);
        expect(isWindowsDrivePath('c:\\foo')).toBe(true);
        expect(isWindowsDrivePath('Z:\\Users')).toBe(true);
    });
    it('rejects POSIX paths and bare drive letters', () => {
        expect(isWindowsDrivePath('/foo')).toBe(false);
        expect(isWindowsDrivePath('foo:bar')).toBe(false);
        expect(isWindowsDrivePath('C')).toBe(false);
        expect(isWindowsDrivePath('C:foo')).toBe(false);
    });
});

describe('splitPathSegments', () => {
    it('uses an empty head for POSIX paths (leading slash comes from the URI scheme)', () => {
        expect(splitPathSegments('/a/b/c')).toEqual({
            head: '',
            segments: ['a', 'b', 'c'],
        });
    });
    it('collapses trailing slashes', () => {
        expect(splitPathSegments('/a/b/')).toEqual({
            head: '',
            segments: ['a', 'b'],
        });
        expect(splitPathSegments('/')).toEqual({
            head: '',
            segments: [],
        });
    });
    it('preserves the drive letter + colon for Windows paths', () => {
        expect(splitPathSegments('C:\\Users\\alex\\phi')).toEqual({
            head: 'C:',
            segments: ['Users', 'alex', 'phi'],
        });
        expect(splitPathSegments('C:/Users/alex')).toEqual({
            head: 'C:',
            segments: ['Users', 'alex'],
        });
    });
    it('returns null for relative paths, NUL bytes, and non-strings', () => {
        expect(splitPathSegments('foo/bar')).toBeNull();
        expect(splitPathSegments('a/b/c\0')).toBeNull();
        expect(splitPathSegments('')).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Plan 1 — local builder
// ---------------------------------------------------------------------------

describe('buildVSCodeURI — local (Plan 1)', () => {
    it('builds a project URI for a POSIX root', () => {
        expect(buildVSCodeURI('/Users/alex/code/phi')).toBe(
            'vscode://file/Users/alex/code/phi',
        );
    });

    it('encodes spaces, Unicode, %, #, ?, and filename colons', () => {
        expect(
            buildVSCodeURI('/Users/alex/my project', 'src/main.go'),
        ).toBe('vscode://file/Users/alex/my%20project/src/main.go');
        expect(
            buildVSCodeURI('/Users/alex/uni', 'café/résumé.md'),
        ).toBe('vscode://file/Users/alex/uni/caf%C3%A9/r%C3%A9sum%C3%A9.md');
        expect(buildVSCodeURI('/foo', 'a%20b.md')).toBe(
            'vscode://file/foo/a%2520b.md',
        );
        expect(buildVSCodeURI('/foo', 'hash#tag.md')).toBe(
            'vscode://file/foo/hash%23tag.md',
        );
        expect(buildVSCodeURI('/foo', 'q?mark.md')).toBe(
            'vscode://file/foo/q%3Fmark.md',
        );
        // Filename colon survives as %3A so the structural URI components
        // (e.g. line:col) remain unambiguous.
        expect(buildVSCodeURI('/foo', 'weird:name.txt')).toBe(
            'vscode://file/foo/weird%3Aname.txt',
        );
    });

    it('preserves a literal backslash inside a POSIX filename', () => {
        // POSIX backslash is part of the filename, NOT a separator.
        expect(buildVSCodeURI('/foo', 'weird\\name.txt')).toBe(
            'vscode://file/foo/weird%5Cname.txt',
        );
    });

    it('treats literal %20 as a filename substring (does not decode)', () => {
        // The builder encodes; it does not pre-decode. A literal `%20`
        // in a filename should become `%2520`.
        expect(buildVSCodeURI('/foo', 'literal%20.txt')).toBe(
            'vscode://file/foo/literal%2520.txt',
        );
    });

    it('encodes double quotes (single quotes pass through encodeURIComponent)', () => {
        // encodeURIComponent preserves the apostrophe by spec; double
        // quotes and angle brackets are encoded.
        expect(buildVSCodeURI('/foo', "it's.txt")).toBe(
            "vscode://file/foo/it's.txt",
        );
        expect(buildVSCodeURI('/foo', '"quote".md')).toBe(
            'vscode://file/foo/%22quote%22.md',
        );
    });

    it('handles trailing separators (including root /)', () => {
        expect(buildVSCodeURI('/Users/alex/code/phi/')).toBe(
            'vscode://file/Users/alex/code/phi',
        );
        expect(buildVSCodeURI('/')).toBe('vscode://file/');
    });

    it('handles Windows drive paths with either separator style', () => {
        expect(buildVSCodeURI('C:\\Users\\alex\\phi', 'src/main.go')).toBe(
            'vscode://file/C:/Users/alex/phi/src/main.go',
        );
        expect(buildVSCodeURI('C:/Users/alex/phi', 'src/main.go')).toBe(
            'vscode://file/C:/Users/alex/phi/src/main.go',
        );
        expect(buildVSCodeURI('c:/Users/alex')).toBe(
            'vscode://file/c:/Users/alex',
        );
    });

    it('rejects relative roots', () => {
        expect(buildVSCodeURI('foo/bar')).toBeNull();
        expect(buildVSCodeURI('./foo')).toBeNull();
        expect(buildVSCodeURI('')).toBeNull();
    });

    it('rejects absolute row paths, traversal, NUL, /dev/null, and UNC roots', () => {
        expect(buildVSCodeURI('/foo', '/abs')).toBeNull();
        expect(buildVSCodeURI('/foo', 'a/../../etc/passwd')).toBeNull();
        expect(buildVSCodeURI('/foo', '../etc/passwd')).toBeNull();
        expect(buildVSCodeURI('/foo', 'a\0b')).toBeNull();
        expect(buildVSCodeURI('/dev/null')).toBeNull();
        expect(buildVSCodeURI('//server/share')).toBeNull(); // UNC
    });

    it('accepts an empty relative path (project action)', () => {
        expect(buildVSCodeURI('/foo', '')).toBe('vscode://file/foo');
        expect(buildVSCodeURI('/foo/bar', undefined)).toBe(
            'vscode://file/foo/bar',
        );
    });

    it('does not URI-decode filesystem names (preserves case and spaces)', () => {
        // Case is preserved verbatim — path equality is OS-dependent and
        // phi relies on the OS canonical form.
        expect(buildVSCodeURI('/Users/Alex/My Project', 'Foo/Bar.GO')).toBe(
            'vscode://file/Users/Alex/My%20Project/Foo/Bar.GO',
        );
    });
});

// ---------------------------------------------------------------------------
// Hostname normalization (Plan 2)
// ---------------------------------------------------------------------------

describe('normalizeHostname', () => {
    it('lowercases and trims', () => {
        expect(normalizeHostname('JUPITER')).toBe('jupiter');
        expect(normalizeHostname('  MyBox  ')).toBe('mybox');
        expect(normalizeHostname('MyBox.local')).toBe('mybox.local');
    });

    it('preserves dots, hyphens, underscores', () => {
        expect(normalizeHostname('jupiter.local')).toBe('jupiter.local');
        expect(normalizeHostname('my-host_42')).toBe('my-host_42');
    });

    it('returns empty for null/undefined/blank', () => {
        expect(normalizeHostname(null)).toBe('');
        expect(normalizeHostname(undefined)).toBe('');
        expect(normalizeHostname('')).toBe('');
        expect(normalizeHostname('   ')).toBe('');
    });

    it('rejects hostnames containing forbidden characters', () => {
        for (const bad of [
            'host name',
            'host\nname',
            'host/name',
            'host\\name',
            'host+name',
            'host@name',
            'host:name',
            'host?name',
            'host#name',
            '/host',
            '.hidden',
        ]) {
            expect(normalizeHostname(bad)).toBe('');
        }
    });

    it('requires a leading letter or digit', () => {
        expect(normalizeHostname('-host')).toBe('');
        expect(normalizeHostname('.host')).toBe('');
        expect(normalizeHostname('_host')).toBe('');
        expect(normalizeHostname('a')).toBe('a');
        expect(normalizeHostname('0host')).toBe('0host');
    });
});

// ---------------------------------------------------------------------------
// Plan 2 — remote builder
// ---------------------------------------------------------------------------

describe('buildVSCodeRemoteURI — remote SSH (Plan 2)', () => {
    const targetFile = {
        root: '/home/alex/project',
        relativePath: 'src/main.go',
        kind: 'file',
    };
    const targetFolder = {
        root: '/home/alex/project',
        kind: 'folder',
    };

    it('builds a project URI without a line suffix', () => {
        expect(buildVSCodeRemoteURI('jupiter', targetFolder)).toBe(
            'vscode://vscode-remote/ssh-remote+jupiter/home/alex/project',
        );
    });

    it('builds a file URI with :1:1 suffix', () => {
        expect(buildVSCodeRemoteURI('jupiter', targetFile)).toBe(
            'vscode://vscode-remote/ssh-remote+jupiter/home/alex/project/src/main.go:1:1',
        );
    });

    it('encodes spaces, Unicode, %, #, ?, and filename colons', () => {
        expect(
            buildVSCodeRemoteURI('jupiter', {
                root: '/home/alex/my project',
                kind: 'folder',
            }),
        ).toBe(
            'vscode://vscode-remote/ssh-remote+jupiter/home/alex/my%20project',
        );
        expect(
            buildVSCodeRemoteURI('jupiter', {
                root: '/home/alex/uni',
                relativePath: 'café/résumé.md',
                kind: 'file',
            }),
        ).toBe(
            'vscode://vscode-remote/ssh-remote+jupiter/home/alex/uni/caf%C3%A9/r%C3%A9sum%C3%A9.md:1:1',
        );
        expect(
            buildVSCodeRemoteURI('jupiter', {
                root: '/foo',
                relativePath: 'hash#tag.md',
                kind: 'file',
            }),
        ).toBe(
            'vscode://vscode-remote/ssh-remote+jupiter/foo/hash%23tag.md:1:1',
        );
        // Filename colon comes out as %3A, distinct from the structural
        // `:1:1` line suffix that follows it.
        expect(
            buildVSCodeRemoteURI('jupiter', {
                root: '/foo',
                relativePath: 'weird:name.txt',
                kind: 'file',
            }),
        ).toBe(
            'vscode://vscode-remote/ssh-remote+jupiter/foo/weird%3Aname.txt:1:1',
        );
    });

    it('uses the normalized hostname (lowercased, trimmed)', () => {
        expect(buildVSCodeRemoteURI('JUPITER', targetFile)).toBe(
            'vscode://vscode-remote/ssh-remote+jupiter/home/alex/project/src/main.go:1:1',
        );
    });

    it('returns null when hostname is missing or invalid', () => {
        expect(buildVSCodeRemoteURI('', targetFile)).toBeNull();
        expect(buildVSCodeRemoteURI('   ', targetFile)).toBeNull();
        expect(buildVSCodeRemoteURI('host name', targetFile)).toBeNull();
        expect(buildVSCodeRemoteURI('-bad', targetFile)).toBeNull();
    });

    it('preserves hostname suffixes and valid SSH aliases', () => {
        expect(
            buildVSCodeRemoteURI('my-bastion.example.com', targetFolder),
        ).toBe(
            'vscode://vscode-remote/ssh-remote+my-bastion.example.com/home/alex/project',
        );
        expect(buildVSCodeRemoteURI('box_42', targetFolder)).toBe(
            'vscode://vscode-remote/ssh-remote+box_42/home/alex/project',
        );
    });

    it('returns null for Windows drive roots and UNC roots', () => {
        expect(
            buildVSCodeRemoteURI('jupiter', {
                root: 'C:/Users/alex',
                kind: 'folder',
            }),
        ).toBeNull();
        expect(
            buildVSCodeRemoteURI('jupiter', {
                root: '//server/share',
                kind: 'folder',
            }),
        ).toBeNull();
    });

    it('rejects absolute row paths, traversal, and NUL', () => {
        expect(
            buildVSCodeRemoteURI('jupiter', {
                root: '/home/alex',
                relativePath: '/abs',
                kind: 'file',
            }),
        ).toBeNull();
        expect(
            buildVSCodeRemoteURI('jupiter', {
                root: '/home/alex',
                relativePath: '../etc/passwd',
                kind: 'file',
            }),
        ).toBeNull();
        expect(
            buildVSCodeRemoteURI('jupiter', {
                root: '/home/alex',
                relativePath: 'a\0b',
                kind: 'file',
            }),
        ).toBeNull();
    });

    it('requires `kind` to be exactly file or folder', () => {
        expect(
            buildVSCodeRemoteURI('jupiter', {
                root: '/foo',
                kind: 'directory',
            }),
        ).toBeNull();
        expect(
            buildVSCodeRemoteURI('jupiter', {
                root: '/foo',
            }),
        ).toBeNull();
    });

    it('appends :1:1 only for files, never folders', () => {
        const folderAt = {
            root: '/home/alex/project',
            relativePath: 'subdir',
            kind: 'folder',
        };
        expect(buildVSCodeRemoteURI('jupiter', folderAt)).toBe(
            'vscode://vscode-remote/ssh-remote+jupiter/home/alex/project/subdir',
        );
    });
});

// ---------------------------------------------------------------------------
// Embedded-detection helper
// ---------------------------------------------------------------------------

describe('isVSCodeLaunchUnsupported', () => {
    it('returns true when the desktop-root marker is present', () => {
        document.documentElement.setAttribute('data-phi-desktop-root', '');
        expect(isVSCodeLaunchUnsupported()).toBe(true);
        document.documentElement.removeAttribute('data-phi-desktop-root');
    });

    it('returns true when the embedded desktop marker is present', () => {
        document.documentElement.setAttribute('data-phi-desktop', '');
        expect(isVSCodeLaunchUnsupported()).toBe(true);
        document.documentElement.removeAttribute('data-phi-desktop');
    });

    it('returns true when ?desktop=1 is in the URL', () => {
        const original = location.search;
        try {
            history.replaceState(null, '', '?desktop=1');
            expect(isVSCodeLaunchUnsupported()).toBe(true);
        } finally {
            history.replaceState(null, '', original || '/');
        }
    });

    it('returns false for plain browser pages', () => {
        document.documentElement.removeAttribute('data-phi-desktop-root');
        document.documentElement.removeAttribute('data-phi-desktop');
        const original = location.search;
        try {
            history.replaceState(null, '', '/');
            expect(isVSCodeLaunchUnsupported()).toBe(false);
        } finally {
            history.replaceState(null, '', original || '/');
        }
    });
});
