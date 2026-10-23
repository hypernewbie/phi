// Bundle entry: Pi loads extensions via jiti.import(path, {default:true})
// and calls the result as a function. jiti returns module.exports as-is
// for CJS, so an ESM default export (bundled as {default: fn}) is not
// callable. Assign the factory as the module itself. Only type imports
// reference the Pi package, so the bundle carries no Pi runtime code.
import factory, { readEditorHistory } from './index.js';

module.exports = factory;
// The hosts check drives the real reader against live editors through
// this handle. Pi ignores extra properties on the factory function.
module.exports.readEditorHistory = readEditorHistory;
