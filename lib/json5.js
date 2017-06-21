'use strict';

const safeRequire = require('./common').safeRequire;
const serialize = require('./json5-serialize');

const json5 = {};
module.exports = json5;

const json5Native =
  safeRequire('../build/Release/json5') ||
  safeRequire('../build/Debug/jsno5');

if (json5Native) {
  Object.assign(json5, json5Native);
  json5.stringify = serialize;
} else {
  console.warn(
    'JSON5 native addon is not built or is not functional. ' +
    'Run `npm install` in order to build it, otherwise you will get ' +
    'poor performance.'
  );
  module.exports = require('./json5-fallback');
}
