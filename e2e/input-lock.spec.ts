import { expect, test } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

// The locked-server path for the remote keyboard: fresh device, no
// cookie — input.html must show the SAME sign-in dialog as the main
// page (auth.js), not a dead end. Login → pane picker loads → send
// works. Reload auto-logins from the saved verifier, no dialog.

let phi: PhiServer;

test.beforeAll(async () => {
    phi = await startPhi();
});

test.afterAll(async () => {
    await phi.stop();
});

async function spawnShell(url: string): Promise<string> {
    for (const coder of process.platform === 'win32'
        ? ['pwsh', 'bash']
        : ['bash']) {
        const res = await fetch(`${url}/api/terminals`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ coder }),
        });
        if (res.ok) {
            const body = (await res.json()) as { pane_id: string };
            return body.pane_id;
        }
    }
    test.skip(true, 'no shell coder available');
    throw new Error('unreachable');
}

test('input.html shows the shared sign-in dialog when cookie is missing', async ({
    browser,
    page,
}) => {
    const password = 'phi-e2e-lock-pw';
    const paneId = await spawnShell(phi.url);

    // Lock the server using the page's own auth module (open API until
    // the password record lands). The pane stays alive across the lock.
    await page.goto(`${phi.url}/input.html`);
    await page.evaluate(
        async ([pw, url]) => {
            const { setAccessPassword } = await import('./auth.js');
            await setAccessPassword(pw);
            // Warm the fetch base for cross-origin-less evaluate imports.
            void url;
        },
        [password, phi.url],
    );

    // Fresh browser context: no cookie, no saved verifier.
    const fresh = await browser.newContext();
    const locked = await fresh.newPage();
    await locked.goto(`${phi.url}/input.html`);

    // The shared dialog, not a dead-end message.
    const dialog = locked.locator('.access-auth-dialog');
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(
        locked.locator('#kb-pane option', { hasText: 'No open terminals' }),
    ).toHaveCount(0, { timeout: 15_000 });

    // Wrong password first: the dialog says so and stays up.
    await locked.locator('#access-auth-password').fill('wrong-password');
    await locked.locator('.access-auth-dialog button[type="submit"]').click();
    await expect(locked.locator('.access-auth-error')).toContainText(
        'Wrong password',
        { timeout: 30_000 },
    );

    // Correct password: dialog resolves, pane picker loads, send works.
    // (Pace past the auth rate-limiter's 2s backoff after the wrong
    // attempt — same cadence a human types at.)
    await locked.waitForTimeout(3_000);
    await locked.locator('#access-auth-password').fill(password);
    await locked.locator('.access-auth-dialog button[type="submit"]').click();
    await expect(dialog).toBeHidden({ timeout: 60_000 });
    const picker = locked.locator('#kb-pane');
    await expect
        .poll(
            async () =>
                picker.evaluate(
                    (el: HTMLSelectElement, id: string) =>
                        [...el.options].some((o) => o.value === id),
                    paneId,
                ),
            { timeout: 15_000 },
        )
        .toBe(true);
    await picker.selectOption(paneId);

    const marker = `kb-locked-${Date.now()}`;
    await locked.locator('#kb-text').fill(marker);
    await locked.locator('#kb-send').click();
    await expect(locked.locator('#kb-text')).toHaveValue('');

    // Reload: saved verifier auto-logins — no dialog, straight to the
    // picker.
    await locked.goto(`${phi.url}/input.html`);
    await expect(locked.locator('.access-auth-overlay')).toHaveCount(0, {
        timeout: 15_000,
    });
    await expect
        .poll(
            async () =>
                picker.evaluate(
                    (el: HTMLSelectElement, id: string) =>
                        [...el.options].some((o) => o.value === id),
                    paneId,
                ),
            { timeout: 15_000 },
        )
        .toBe(true);

    await fresh.close();
});
