import type { Locator, Page } from '@playwright/test';

// The desktop tab-bar popup and the compact drawer render the same rows from
// one builder: on phones the brand opens the drawer, on wide screens the
// popup. Select whichever list is populated so a spec works in both layouts.
export function tabList(page: Page): Locator {
    // `.first()` keeps the locator single: both containers can be in the DOM
    // at once, and only the populated one matches.
    return page
        .locator(
            '#drawer-tabs-body:has(.hostname-dropdown-row), #hostname-tabs-dropdown:has(.hostname-dropdown-row)',
        )
        .first();
}
