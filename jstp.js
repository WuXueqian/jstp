'use strict';

const jstp = {};
module.exports = jstp;

Object.assign(jstp,
  require('./lib/json5'),
  require('./lib/errors'),
  require('./lib/applications')
);

jstp.RemoteProxy = require('./lib/remote-proxy');
jstp.Connection = require('./lib/connection');
jstp.Server = require('./lib/server');

jstp.tcp = require('./lib/transport.tcp');
jstp.ipc = require('./lib/transport.ipc');
jstp.ws = require('./lib/transport.ws');

jstp.simpleAuth = require('./lib/simple-auth');
