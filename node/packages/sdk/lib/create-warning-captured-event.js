'use strict';

const isObject = require('type/object/is');
const ensureString = require('type/string/ensure');
const CapturedEvent = require('./captured-event');

module.exports = (message, options = {}) => {
  const timestamp = process.hrtime.bigint();
  message = ensureString(message, { name: 'message' });
  if (!isObject(options)) options = {};

  return new CapturedEvent('telemetry.warning.generated.v1', {
    timestamp,
    customTags: options.tags,
    customFingerprint: options.fingerprint,
    tags: { 'warning.message': message, 'warning.type': options.type || 1 },
    _origin: options._origin,
  });
};
