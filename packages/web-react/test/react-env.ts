import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const mounted: Array<() => Promise<void>> = [];

export async function mount(node: ReactNode) {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const render = async (next: ReactNode) => {
        await act(async () => root.render(next));
    };
    const dispose = async () => {
        await act(async () => root.unmount());
        host.remove();
    };
    mounted.push(dispose);
    await render(node);
    return { host, render };
}

export async function cleanup() {
    for (const dispose of mounted.splice(0).reverse()) await dispose();
}
