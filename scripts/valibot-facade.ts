// Curated valibot facade for the shipping frontend.
//
// `web/valibot.js` is built from this file by `scripts/valibot.mjs`, and
// `web-src/valibot.d.ts` is generated from the same source. The export list is
// deliberately curated: a whole-namespace re-export would be ~15 KB gzip
// instead of ~2.7 KB, because it defeats tree-shaking.
//
// To use another valibot function from `web-src`, add it here, rebuild, and
// re-check the size budget in the plan.
import {
    array,
    boolean,
    check,
    exactOptional,
    fallback,
    finite,
    integer,
    literal,
    maxBytes,
    maxLength,
    maxValue,
    minLength,
    minValue,
    null as nullSchema,
    nullable,
    number,
    object,
    optional,
    picklist,
    pipe,
    record,
    safeInteger,
    safeParse,
    string,
    strictObject,
    transform,
    union,
    unknown,
} from 'valibot';

export const v = {
    array,
    boolean,
    check,
    exactOptional,
    fallback,
    finite,
    integer,
    literal,
    maxBytes,
    maxLength,
    maxValue,
    minLength,
    minValue,
    null: nullSchema,
    nullable,
    number,
    object,
    optional,
    picklist,
    pipe,
    record,
    safeInteger,
    safeParse,
    string,
    strictObject,
    transform,
    union,
    unknown,
};
