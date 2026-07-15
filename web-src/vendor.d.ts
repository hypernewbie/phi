export {};

// Ambient vendor globals loaded by web/index.html. These are
// exposed on window via <script> tags in the HTML, so TypeScript
// needs explicit declarations to call methods on them from
// converted modules. Stays as `any` on purpose: the goal of this
// migration is to type phi's boundaries, not third-party
// internals. In particular, xterm monkey-patches `term.write` and
// the .d.ts escape hatches below let phi keep those calls without
// fighting TypeScript.
declare global {
    interface Window {
        Terminal: any;
        FitAddon: any;
        SearchAddon: any;
        WebglAddon: any;
        Unicode11Addon: any;
        marked: any;
        hljs: any;
        Diff2Html: any;
        Sortable: any;
    }
}
