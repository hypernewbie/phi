// Config bends to the existing hand-written web/index.html, not vice
// versa. Every disabled rule below fights an established convention in
// that file rather than catching a real defect — see the one-line
// reason on each.
export default {
    // Stops config cascading past this directory — --config is not enough
    // on its own to prevent html-validate from walking up and merging in
    // any other .htmlvalidate.js it finds further up the tree.
    root: true,
    extends: ['html-validate:recommended'],
    rules: {
        // 43 sites use style="..." for one-off dynamic/inline tweaks; this
        // is the existing convention, not a defect. No CSS build step makes
        // moving these to classes a much bigger, unrelated change.
        'no-inline-style': 'off',

        // No <form> elements exist in this file, so the implicit-submit
        // hazard this rule guards against doesn't apply; 65 icon buttons
        // rely on the default type by convention.
        'no-implicit-button-type': 'off',

        // Pre-existing a11y gap: ~14 icon-only buttons carry a `title` but
        // no aria-label/visible text. Real, but a mass edit across the
        // file — left as a warning (not blocking) rather than silenced, so
        // it stays visible instead of disappearing into "off".
        'text-content': 'warn',

        // Scattered trailing whitespace on blank/indent lines; not a
        // defect, not worth a file-wide trim for a lint tooling swap.
        'no-trailing-whitespace': 'off',
    },
};
