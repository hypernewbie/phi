// Cross-tab config sync. Every message carries the appearance owner;
// scoped legacy tabs ignore ownerless messages.
import { appearanceOwner, readAppearanceScope } from './appearance-scope.ts';

export function broadcastConfigSync(
    type: string,
    payload: Record<string, unknown> = {},
): void {
    try {
        if (typeof BroadcastChannel === 'undefined') return;
        const scope = readAppearanceScope();
        if (scope === null) return;
        const channel = new BroadcastChannel('phi_config_sync');
        channel.postMessage({
            type,
            owner: appearanceOwner(scope),
            ...payload,
        });
        channel.close();
    } catch {
        // Cross-tab sync is best-effort.
    }
}
