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

const goreleaserConfig = readFileSync(
  path.join(import.meta.dirname, '..', '..', '..', '.goreleaser.yaml'),
  'utf8',
);

const pinnedActions = {
  'actions/checkout': {
    tag: 'v5',
    sha: 'fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09',
  },
  'actions/setup-go': {
    tag: 'v6',
    sha: '924ae3a1cded613372ab5595356fb5720e22ba16',
  },
  'pnpm/action-setup': {
    tag: 'v4',
    sha: 'f40ffcd9367d9f12939873eb1018b921a783ffaa',
  },
  'actions/setup-node': {
    tag: 'v5',
    sha: 'a0853c24544627f65ddf259abe73b1d18a591444',
  },
  'goreleaser/goreleaser-action': {
    tag: 'v7',
    sha: 'f06c13b6b1a9625abc9e6e439d9c05a8f2190e94',
  },
  'actions/upload-artifact': {
    tag: 'v4',
    sha: 'ea165f8d65b6e75b540449e92b4886f43607fa02',
  },
  'actions/download-artifact': {
    tag: 'v4',
    sha: 'd3f86a106a0bac45b974a628896c90dbdf5c8093',
  },
} as const;

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

  it('verifies the signing key immediately before signing the pet archive', () => {
    const verificationStep = workflow.indexOf(
      '      - name: Verify pet signing key',
    );
    const signingStep = workflow.indexOf('      - name: Sign pet archive');
    const uploadStep = workflow.indexOf(
      '      - name: Upload signed pet assets',
    );
    const secretMapping =
      '          PHI_PET_ED25519_PRIVATE_KEY: >-\n' +
      '            ${{ secrets.PHI_PET_ED25519_PRIVATE_KEY }}';

    expect(verificationStep).toBeGreaterThanOrEqual(0);
    expect(signingStep).toBeGreaterThan(verificationStep);
    expect(uploadStep).toBeGreaterThan(signingStep);

    const verificationBlock = workflow.slice(verificationStep, signingStep);
    const signingBlock = workflow.slice(signingStep, uploadStep);
    expect(verificationBlock).toContain(
      '        working-directory: desktop/electron',
    );
    expect(verificationBlock).toContain(secretMapping);
    expect(verificationBlock).toContain(
      '        run: node scripts/verify-pet-signing-key.mjs',
    );
    expect(signingBlock).toContain(secretMapping);
  });

  it('allows npm publication only for exact stable release tags', () => {
    expect(workflow).not.toContain(
      "if: ${{ !contains(github.ref_name, '-alpha') }}",
    );

    const publishStep = workflow.indexOf('      - name: Publish to NPM');
    const runStart = workflow.indexOf('        run: |', publishStep);
    const envStart = workflow.indexOf('        env:', runStart);
    const publishScript = workflow.slice(runStart, envStart);
    const versionAssignment = 'version=${GITHUB_REF_NAME#v}';
    const stableGuard =
      'if [[ ! "$version" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]]; then';
    const guardIndex = publishScript.indexOf(stableGuard);

    expect(publishStep).toBeGreaterThanOrEqual(0);
    expect(runStart).toBeGreaterThan(publishStep);
    expect(envStart).toBeGreaterThan(runStart);
    expect(publishScript.indexOf(versionAssignment)).toBeLessThan(guardIndex);
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(publishScript).toContain('Skipping npm publication');
    expect(publishScript).toContain('not a stable');
    expect(publishScript.slice(guardIndex)).toContain('exit 0');

    for (const command of ['npm view', 'npm version', 'npm publish']) {
      expect(publishScript.indexOf(command)).toBeGreaterThan(guardIndex);
    }
  });

  it('pins every workflow action to its documented immutable commit', () => {
    const lines = workflow.split('\n');
    const references: string[] = [];

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!/^[ \t]*uses:/.test(line)) continue;

      const inlineReference = line.match(
        /^[ \t]*uses:[ \t]+([^ \t#]+@[0-9a-f]{40})[ \t]+#[ \t]+v[0-9]+[ \t]*$/,
      );
      if (inlineReference) {
        references.push(inlineReference[1]);
        continue;
      }

      expect(line).toMatch(/^[ \t]*uses:[ \t]+>-[ \t]+#[ \t]+v[0-9]+[ \t]*$/);
      const foldedReference = lines[index + 1]?.trim();
      expect(foldedReference).toMatch(/^[^ \t#]+@[0-9a-f]{40}$/);
      references.push(foldedReference ?? '');
    }

    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      expect(reference).toMatch(/^[^@]+@[0-9a-f]{40}$/);
    }
    for (const [action, pin] of Object.entries(pinnedActions)) {
      expect(references).toContain(`${action}@${pin.sha}`);
      const inlineComment = `${action}@${pin.sha} # ${pin.tag}`;
      const foldedComment =
        `uses: >- # ${pin.tag}\n` + `          ${action}@${pin.sha}`;
      expect(
        workflow.includes(inlineComment) || workflow.includes(foldedComment),
      ).toBe(true);
    }
  });

  it('uploads both signed pet assets and desktop package artifacts', () => {
    expect(workflow).toMatch(
      /gh release upload[\s\S]*phi-pet-\$\{GITHUB_REF_NAME#v\}\.tar\.gz[\s\S]*phi-pet-\$\{GITHUB_REF_NAME#v\}\.manifest\.json/,
    );
    expect(workflow).toContain(
      'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
    );
    expect(workflow).toContain('desktop/electron/out/phi-client-*.dmg');
    expect(workflow).toContain(
      'gh release upload --repo "$GITHUB_REPOSITORY" "$GITHUB_REF_NAME"',
    );
  });

  it('publishes the draft only after every release asset is ready', () => {
    const publishRelease = workflow.indexOf('  publish-release:');
    const publishBlock = workflow.slice(publishRelease);

    expect(publishRelease).toBeGreaterThanOrEqual(0);
    expect(goreleaserConfig).toContain('release:\n  draft: true');
    expect(publishBlock).toContain('needs: [desktop-release, npm-publish]');
    expect(publishBlock).toContain(
      'gh release edit --repo "$GITHUB_REPOSITORY" "$GITHUB_REF_NAME"',
    );
    expect(publishBlock).toContain('--draft=false');
  });
});
