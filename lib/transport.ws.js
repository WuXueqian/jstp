'use strict';

const events = require('events');
const http = require('http');
const https = require('https');
const util = require('util');

const websocket = require('websocket');

const json5 = require('./json5');
const common = require('./common');
const Server = require('./server');
const Client = require('./client');
const constants = require('./internal-constants');
const transportCommon = require('./transport.common');

const WebSocketServer = websocket.server;
const WebSocketClient = websocket.client;

const ws = {};
module.exports = ws;

// Create a JSTP server bound to a WebSocket server
//   config - HTTP/HTTPS and WebSocket servers config
//   applications - applications index
//   authCallback - authentication callback
//   originCheckStrategy - a function that checks the origin of a WebSocket
//     request and returns a boolean indicating whether to allow it (optional)
//
ws.createServer = (config, applications, authCallback, originCheckStrategy) => {
  let secure = false;

  if (typeof(config) === 'number') {
    config = { port: config };
  } else if (config.key && config.cert) {
    secure = true;
  }

  const httpServer = (
    secure ?
    https.createServer(config) :
    http.createServer()
  );

  httpServer.on('request', httpRequestHandler);

  const wsServer = new JstpWebSocketServer(httpServer,
    config, originCheckStrategy);
  const jstpServer = new Server(wsServer, applications,
    authCallback, config.heartbeat);

  return jstpServer;
};

// Create a JSTP client that will transfer data over a WebSocket connection
//   config - WebSocket client config
//   application - client application
//
ws.createClient = (config, application) => {
  if (typeof(config) === 'string') {
    config = { url: config };
  }

  const wsClient = new JstpWebSocketClient(config);
  const jstpClient = new Client(wsClient, application, config.heartbeat);

  return jstpClient;
};

// HTTP requests handler for the HTTP/HTTPS server WebSocket server is bound to
//  request - HTTP request
//  response - HTTP response
//
function httpRequestHandler(request, response) {
  response.writeHead(400);
  response.end();
}

// WebSocket server for JSTP server
//   httpServer - HTTP/HTTPS server instance
//   config - HTTP/HTTPS and WebSocket servers config
//   originCheckStrategy - a function that checks the origin of a WebSocket
//     request and returns a boolean indicating whether to allow it (optional)
//
function JstpWebSocketServer(httpServer, config,
      originCheckStrategy = ws.allowAllOriginCheckStrategy) {
  events.EventEmitter.call(this);

  this.httpServer = httpServer;

  // Make empty object the first argument rather than config since we don't
  // know where config came from and it may be undesirable to mutate it
  this.config = Object.assign({}, config, {
    httpServer,
    autoAcceptConnections: false
  });

  this.isOriginAllowed = originCheckStrategy;

  common.forwardMultipleEvents(httpServer, this, [
    'listening',
    'close'
  ]);
  common.forwardEvent(httpServer, this, 'clientError', 'error');

  this.wsServer = new WebSocketServer(this.config);
  this.wsServer.on('request', this._onRequest.bind(this));
}

util.inherits(JstpWebSocketServer, events.EventEmitter);
ws.JstpWebSocketServer = JstpWebSocketServer;

// Switch the server into listening state
//   callback - callback function (optional)
//
JstpWebSocketServer.prototype.listen = function(callback) {
  this.httpServer.listen(this.config.port, callback);
};

// Stop listening for connections
//   callback - callback function (optional)
//
JstpWebSocketServer.prototype.close = function(callback) {
  this.httpServer.close(callback);
};

// Create a JSTP transport from a WebSocket connection
//   connection - WebSocket connection
//
JstpWebSocketServer.prototype.createTransport = function(connection) {
  return new WebSocketTransport(connection);
};

// Returns address this server is bound to
JstpWebSocketServer.prototype.address = function() {
  return this.httpServer.address();
};

// WebSocket request handler
//   request - WebSocket request
//
JstpWebSocketServer.prototype._onRequest = function(request) {
  if (!this.isOriginAllowed(request.origin)) {
    request.reject();
    return;
  }

  const connection =
    request.accept(constants.WEBSOCKET_PROTOCOL_NAME, request.origin);

  this.emit('connection', connection);
};

// Default originCheckStrategy value for ws.createClient and
// JstpWebSocketServer constructor
//
ws.allowAllOriginCheckStrategy = function(/* origin */) {
  return true;
};

// Client WebSocket connection for JSTP
//   config - WebSocket client configuration
//
function JstpWebSocketClient(config) {
  events.EventEmitter.call(this);

  this.config = config;
  this.wsClient = new WebSocketClient(config);
  this.wsConnection = null;
  this.isConnected = false;
}

util.inherits(JstpWebSocketClient, events.EventEmitter);
ws.JstpWebSocketClient = JstpWebSocketClient;

// Connect to the server
//  callback - callback function
//
JstpWebSocketClient.prototype.connect = function(callback) {
  if (this.isConnected) {
    if (callback) {
      callback(new Error('Already connected'));
    }
    return;
  }

  this.wsClient.once('connect', (connection) => {
    this.wsConnection = connection;
    this.isConnected = true;

    this.wsConnection.on('error', this._onError.bind(this));
    this.wsConnection.on('close', this._onClose.bind(this));

    if (callback) {
      callback();
    }

    this.emit('connect');
  });

  this.wsClient.once('connectFailed', (error) => {
    if (callback) {
      return callback(error);
    }

    this.emit('error', error);
  });

  this.wsClient.connect(this.config.url, constants.WEBSOCKET_PROTOCOL_NAME);
};

// Disconnect from the server
//
JstpWebSocketClient.prototype.disconnect = function(callback) {
  transportCommon.ensureClientConnected(this);

  if (callback) {
    this.wsConnection.once('close', callback);
  }

  this.wsConnection.close();
};

// Create a JSTP transport from the underlying WebSocket connection
//
JstpWebSocketClient.prototype.createTransport = function() {
  transportCommon.ensureClientConnected(this);
  return new WebSocketTransport(this.wsConnection);
};

// Connection error handler
//   error - error that has occured
//
JstpWebSocketClient.prototype._onError = function(error) {
  this.emit('error', error);
};

// Connection close handler
//
JstpWebSocketClient.prototype._onClose = function() {
  this.isConnected = false;
};

// WebSocket transport for JSTP
//   connection - WebSocket connection
//
function WebSocketTransport(connection) {
  events.EventEmitter.call(this);

  this.connection = connection;
  this.remoteAddress = connection.remoteAddress;

  this.connection.on('message', this._onMessage.bind(this));
  this.connection.on('close', this._onClose.bind(this));
  this.connection.on('error', this._onError.bind(this));
}

util.inherits(WebSocketTransport, events.EventEmitter);
ws.WebSocketTransport = WebSocketTransport;

// Send data over the connection
//   data - Buffer or string
//
WebSocketTransport.prototype.send = function(data) {
  if (Buffer.isBuffer(data)) {
    data = data.toString();
  }

  this.connection.sendUTF(data);
};

// End the connection optionally sending the last chunk of data
//   data - Buffer or string (optional)
//
WebSocketTransport.prototype.end = function(data) {
  if (data) {
    this.send(data);
  }

  this.connection.close();
};

// WebSocket message handler
//   message - WebSocket message
//
WebSocketTransport.prototype._onMessage = function(message) {
  const data = (
    message.type === 'utf8' ?
    message.utf8Data :
    message.binaryData.toString()
  );

  let packet;
  try {
    packet = json5.parse(data);
  } catch (error) {
    this.emit('error', error);
    return;
  }

  this.emit('packet', packet);
};

// Connection close handler
//
WebSocketTransport.prototype._onClose = function() {
  this.emit('close');
};

// Connection error handler
//   error - error that has occured
//
WebSocketTransport.prototype._onError = function(error) {
  this.connection.drop();
  this.emit('error', error);
};
