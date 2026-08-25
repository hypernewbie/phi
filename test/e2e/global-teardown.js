import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export default async function globalTeardown() {
    const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
    rmSync(resolve(root, 'test/e2e/.runtime-home'), {
        recursive: true,
        force: true,
    });
    if (process.env.PI_KEEP_E2E_ARTIFACTS !== '1') {
        rmSync(resolve(root, '.playwright/pi-fake.log'), { force: true });
    }
}
