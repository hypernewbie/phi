export {};

// Ambient vendor globals loaded by web/index.html. These are
// exposed on window via <script> tags in the HTML, so TypeScript
// needs explicit declarations to call methods on them from
// converted modules. Stays as `any` on purpose: the goal of this
// migration is to type phi's boundaries, not third-party
// internals. In particular, xterm monkey-patches `term.write` and
// the .d.ts escape hatches below let phi keep those calls without
// fighting TypeScript.
/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
    interface Window {
        // biome-ignore lint/suspicious/noExplicitAny: vendor globals are intentionally untyped
        Terminal: any;
        // biome-ignore lint/suspicious/noExplicitAny: vendor globals are intentionally untyped
        FitAddon: any;
        // biome-ignore lint/suspicious/noExplicitAny: vendor globals are intentionally untyped
        SearchAddon: any;
        // biome-ignore lint/suspicious/noExplicitAny: vendor globals are intentionally untyped
        SerializeAddon?: any;
        // biome-ignore lint/suspicious/noExplicitAny: vendor globals are intentionally untyped
        WebglAddon: any;
        // biome-ignore lint/suspicious/noExplicitAny: vendor globals are intentionally untyped
        Unicode11Addon: any;
        // biome-ignore lint/suspicious/noExplicitAny: vendor globals are intentionally untyped
        marked: any;
        // biome-ignore lint/suspicious/noExplicitAny: vendor globals are intentionally untyped
        hljs: any;
        // biome-ignore lint/suspicious/noExplicitAny: vendor globals are intentionally untyped
        Diff2Html: any;
        // biome-ignore lint/suspicious/noExplicitAny: vendor globals are intentionally untyped
        Sortable: any;
        // biome-ignore lint/suspicious/noExplicitAny: vendor globals are intentionally untyped
        DOMPurify: any;
        // biome-ignore lint/suspicious/noExplicitAny: vendor globals are intentionally untyped
        Chart: any;
        // biome-ignore lint/suspicious/noExplicitAny: vendor globals are intentionally untyped
        Viewer: any;
        // biome-ignore lint/suspicious/noExplicitAny: vendor globals are intentionally untyped
        Plyr: any;
        customElements: {
            // biome-ignore lint/suspicious/noExplicitAny: vendor globals are intentionally untyped
            get(name: string): any;
            define(
                name: string,
                // biome-ignore lint/suspicious/noExplicitAny: vendor globals are intentionally untyped
                ctor: any,
                options?: ElementDefinitionOptions,
            ): void;
        };
        Diff: {
            diffWords(
                oldStr: string,
                newStr: string,
            ): Array<{
                value: string;
                added?: boolean;
                removed?: boolean;
            }>;
        };
    }
}
