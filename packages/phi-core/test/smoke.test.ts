import { expect, it } from 'vitest';

it('resolves the core package through its source export', async () => {
    const core = await import('@phi/core');
    expect(core).toBeDefined();
    expect(import.meta.resolve('@phi/core')).toMatch(/\/src\/index\.ts$/);
});
