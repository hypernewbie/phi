// Config bends to the existing hand-written web/style.css, not vice versa.
// Every disabled rule below fights an established convention in that file
// rather than catching a real defect — see the one-line reason on each.
export default {
  extends: "stylelint-config-standard",
  rules: {
    // Legacy rgba()/decimal-alpha notation is used consistently (140+
    // sites); switching to modern rgb()/percentage-alpha would be a
    // mass reformat for zero behavior change.
    "color-function-notation": null,
    "color-function-alias-notation": null,
    "alpha-value-notation": null,

    // File relies on compact single-line rules (utility-ish declarations)
    // throughout; not a defect.
    "declaration-block-single-line-max-declarations": null,

    // Blank-line-before conventions (rules, comments, at-rules, custom
    // properties) aren't followed consistently in this file; enforcing
    // them now would be a mass reformat, not a real fix.
    "rule-empty-line-before": null,
    "comment-empty-line-before": null,
    "at-rule-empty-line-before": null,
    "custom-property-empty-line-before": null,

    // No CSS build step/autoprefixer — -webkit-/-moz- prefixes are the
    // real cross-browser fallback (backdrop-filter, appearance), not
    // dead weight.
    "property-no-vendor-prefix": null,

    // File consistently uses classic min-width/max-width @media syntax;
    // range-notation is purely cosmetic modernization.
    "media-feature-range-notation": null,

    // Default kebab-case pattern plus an explicit "--modifier" suffix, for
    // the established BEM convention here (.kanban-card--done etc.), plus
    // one narrow exception: .role-toolResult is built at runtime as
    // `role-${msg.role}` (web-src/sessions.ts) from the message-role enum,
    // whose "toolResult" value is camelCase by protocol, not by CSS choice
    // — renaming the class alone wouldn't fix anything. Everything else
    // still has to be real kebab-case; this still catches typos.
    "selector-class-pattern":
      "^(role-toolResult|[a-z][a-z0-9]*(-[a-z0-9]+)*(--[a-z0-9]+(-[a-z0-9]+)*)?)$",

    // Reused selectors ("reopening" a class in a later section to add a
    // scoped tweak, e.g. .brand { cursor: help }) are a deliberate
    // organization pattern in this file, not accidental duplication.
    "no-duplicate-selectors": null,

    // This monolith global stylesheet reuses class names across
    // independent sections; the source-order-vs-specificity heuristic
    // produces false positives at this scale rather than catching real
    // cascade bugs. Unrelated to the @media-brace defect class this
    // migration exists to preserve (see html-validate/stylelint syntax
    // errors for that).
    "no-descending-specificity": null,

    // Default kebab-case pattern plus an explicit allowlist for the 7
    // legacy camelCase keyframe names already in the file (renaming would
    // touch declaration + every animation call-site for a cosmetic gain).
    // Any new keyframe name still has to be kebab-case or on this list.
    "keyframes-name-pattern":
      "^(emptyBgPulse|emptyFadeSlide|slideUp|modalRise|slideDown|kanbanFadeIn|kanbanSlideInFromRight|[a-z][a-z0-9]*(-[a-z0-9]+)*)$",

    // File writes hex colors at full length by convention (only 3 of 34
    // distinct hex colors already happen to be shorthand-able); no
    // functional difference either way.
    "color-hex-length": null,

    // Unquoted font-family idents (BlinkMacSystemFont, Roboto, Courier)
    // and currentColor are flagged as "keywords" by this rule; lowering
    // their case would hurt readability for zero behavior change.
    "value-keyword-case": null,

    // word-break: break-word is deprecated in favor of overflow-wrap,
    // but still functional everywhere and behaves subtly differently;
    // not swapping without a deliberate behavior review.
    "declaration-property-value-keyword-no-deprecated": null,

    // Longhand overflow-x/-y and inset-equivalent longhands are used at
    // 4 scattered sites; combining into shorthand is a cosmetic no-op,
    // not a defect.
    "declaration-block-no-redundant-longhand-properties": null,

    // 4-value shorthands with a redundant trailing value (e.g. "0 0 6px
    // 0") appear at 7 scattered sites; collapsing them is cosmetic, not
    // a defect.
    "shorthand-property-no-redundant-values": null,
  },
};
