// Bundle entry: Pi loads extensions via jiti.import(path, {default:true})
// and calls the result as a function. jiti returns module.exports as-is
// for CJS, so an ESM default export (bundled as {default: fn}) is not
// callable. Assign the factory as the module itself. Only type imports
// reference the Pi package, so the bundle carries no Pi runtime code.
import factory from './index.js';

module.exports = factory;
