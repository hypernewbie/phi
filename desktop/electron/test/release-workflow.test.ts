// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  path.join(
    import.meta.dirname,
    '..',
    '..',
    '..',
    '.github',
    'workflows',
    'release.yml',
  ),
  'utf8',
);

describe('release workflow pet signing and release uploads', () => {
  it('keeps shell continuations inside literal block scalars', () => {
    // A plain (non-block) YAML run scalar folds "\\\n" into a literal
    // "\\ " which the shell reads as an escaped space: v0.20.0-alpha.1
    // failed with sign-pet-package usage errors and electron-builder
    // printing help. Multi-line run steps must use "run: |".
    for (const line of workflow.split('\n')) {
      const match = line.match(/^\s*run: (.*)$/);
      if (!match) continue;
      const value = match[1];
      if (value === '|' || value.startsWith('>')) continue;
      expect(value.endsWith('\\')).toBe(false);
    }
  });

  it('maps the signing secret into the signer environment', () => {
    expect(workflow).toContain('PHI_PET_ED25519_PRIVATE_KEY: >-');
    expect(workflow).toContain('${{ secrets.PHI_PET_ED25519_PRIVATE_KEY }}');
  });

  it('uploads both signed pet assets and desktop package artifacts', () => {
    expect(workflow).toMatch(
      /gh release upload[\s\S]*phi-pet-\$\{GITHUB_REF_NAME#v\}\.tar\.gz[\s\S]*phi-pet-\$\{GITHUB_REF_NAME#v\}\.manifest\.json/,
    );
    expect(workflow).toContain('actions/upload-artifact@v4');
    expect(workflow).toContain('desktop/electron/out/phi-client-*.dmg');
    expect(workflow).toContain(
      'gh release upload --repo "$GITHUB_REPOSITORY" "$GITHUB_REF_NAME"',
    );
  });
});
