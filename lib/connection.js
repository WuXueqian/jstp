'use strict';

const events = require('events');
const timers = require('timers');
const util = require('util');

const common = require('./common');
const json5 = require('./json5');
const errors = require('./errors');
const RemoteProxy = require('./remote-proxy');

module.exports = Connection;

let nextConnectionId = 0;

// Mapping of packet types to handler function names (forward declaration, see
// definition below the Connection class).
//
let PACKET_HANDLERS = null;

// JSTP connection class
//   transport - an abstract socket
//   server - JSTP server instance, used only for server-side parts
//            of connections (optional, but either server or client
//            is required)
//   client - JSTP client instance, used only for client-side parts
//            of connections (optional, but either server or client
//            is required)
//
function Connection(transport, server, client) {
  events.EventEmitter.call(this);

  this.transport = transport;
  this.server = server;
  this.client = client;

  this.id = nextConnectionId++;
  this._nextPacketId = 0;

  if (server && !client) {
    this._packetIdDelta = -1;
  } else if (client && !server) {
    this._packetIdDelta = 1;
  } else {
    throw new Error('Either server or client is required');
  }

  this.remoteAddress = transport.remoteAddress;

  this._callbacks = {};

  this.handshakeDone = false;
  this.username = null;
  this.sessionId = null;

  this.application = null;
  this.remoteProxies = {};

  this._heartbeatCallbackInstance = null;

  // Defined in constructor to be used as default callback in callMethod
  // without binding it.
  this._emitError = (error) => {
    if (error) this.emit('error', error);
  };

  transport.on('packet', this._processPacket.bind(this));
  transport.on('close', this._onSocketClose.bind(this));
  transport.on('error', this._onSocketError.bind(this));
}

util.inherits(Connection, events.EventEmitter);

// Send a call packet over the connection
//   interfaceName - name of an interface
//   methodName - name of a method
//   args - method arguments
//   callback - callback function that is invoked after a callback packet
//     has been received
//
Connection.prototype.callMethod = function(
  interfaceName, methodName, args, callback
) {
  const packet = this.createPacket('call', interfaceName, methodName, args);
  const packetId = packet.call[0];
  this._callbacks[packetId] = callback || this._emitError;
  this._send(packet);
};

// Send a callback packet over the connection
//   packetId - id of a call packet to send callback packet for
//   error - error that has occured or null
//   result - result of a remote method if there was no error
//
Connection.prototype.callback = function(packetId, error, result) {
  let packet;

  if (error) {
    error = errors.RemoteError.getJstpArrayFor(error);
    packet = this.createPacket('callback', null, 'error', error);
  } else {
    packet = this.createPacket('callback', null, 'ok', result);
  }

  packet.callback[0] = packetId;

  this._send(packet);
};

// Send an event packet over the connection
//   interfaceName - name of an interface
//   eventName - name of an event
//   args - event arguments as an array
//
Connection.prototype.emitRemoteEvent = function(
  interfaceName, eventName, args
) {
  const packet = this.createPacket('event', interfaceName, eventName, args);
  this._send(packet);
};

// Send a handshake packet over the connection
//   appName - name of an application to connect to
//   login - user name (optional)
//   password - user password (optional)
//   callback - callback function to invoke after the handshake is completed
//
Connection.prototype.handshake = function(appName, login, password, callback) {
  const packet = login && password ?
    this.createPacket('handshake', appName, 'login', [login, password]) :
    this.createPacket('handshake', appName);

  const packetId = packet.handshake[0];
  this._callbacks[packetId] = (error, sessionId) => {
    if (login && password && !error) {
      this.username = login;
    }
    this.sessionId = sessionId;
    if (callback) {
      callback(error, sessionId);
    }
  };

  this._send(packet);
};

// Send an inspect packet over the connection
//   interfaceName - name of an interface to inspect
//   callback - callback function to invoke after another side responds
//              with interface introspection
//
Connection.prototype.inspectInterface = function(interfaceName, callback) {
  const packet = this.createPacket('inspect', interfaceName, null, null);
  const packetId = packet.inspect[0];

  this._callbacks[packetId] = (error, ...methods) => {
    if (error) {
      if (callback) {
        callback(error);
      } else {
        this.emit('error', error);
      }
      return;
    }

    const proxy = new RemoteProxy(this, interfaceName, methods);
    this.remoteProxies[interfaceName] = proxy;

    if (callback) {
      callback(null, proxy);
    }
  };

  this._send(packet);
};

// Send a ping packet
//
Connection.prototype.ping = function(callback) {
  const packet = this.createPacket('ping');
  const packetId = packet.ping[0];
  this._callbacks[packetId] = callback || common.doNothing;
  this._send(packet);
};

// Send a pong packet
//
Connection.prototype.pong = function(packetId) {
  const packet = { pong: [packetId] };
  this._send(packet);
};

// Start sending heartbeat packets
//   interval - heartbeat interval in milliseconds
//
Connection.prototype.startHeartbeat = function(interval) {
  this._heartbeatCallbackInstance =
    this._heartbeatCallback.bind(this, interval);
  this._heartbeatCallbackInstance();
};

// Internal function used by startHeartbeat
//
Connection.prototype._heartbeatCallback = function(interval) {
  this.transport.send('{}');
  this.setTimeout(interval, this._heartbeatCallbackInstance);
};

// Stop sending heartbeat packets
//
Connection.prototype.stopHeartbeat = function() {
  if (this._heartbeatCallbackInstance) {
    this.clearTimeout(this._heartbeatCallbackInstance);
    this._heartbeatCallbackInstance = null;
  }
};

// Create a JSTP packet
//   kind - packet kind
//   target - name of an interface or an application (optional)
//   verb - action specific for different packet kinds
//   args - action arguments
//
Connection.prototype.createPacket = function(kind, target, verb, args) {
  const packet = {
    [kind]: (
      target ?
      [this._nextPacketId, target] :
      [this._nextPacketId]
    )
  };

  if (verb) {
    packet[verb] = args;
  }

  this._nextPacketId += this._packetIdDelta;

  return packet;
};

// Close the connection
//
Connection.prototype.close = function() {
  this.stopHeartbeat();
  this.transport.end();
};

// Set a timeout using timers.enroll()
//   milliseconds - amount of milliseconds
//   callback - callback function
//
Connection.prototype.setTimeout = function(milliseconds, callback) {
  timers.enroll(this, milliseconds);
  timers._unrefActive(this);
  this.once('_timeout', callback);
};

// Clear a timeout set with Connection#setTimeout
//   handler - timer callback to remove
//
Connection.prototype.clearTimeout = function(handler) {
  timers.unenroll(this);
  this.removeListener('_timeout', handler);
};

// timers.enroll() timeout handler
//
Connection.prototype._onTimeout = function() {
  this.emit('_timeout');
};

// Send a JSTP packet over this connection
//   packet - a packet to send
//
Connection.prototype._send = function(packet) {
  const data = json5.stringify(packet);
  this.transport.send(data);
};

// Close the connection, optionally sending a final packet
//   packet - a packet to send (optional)
//
Connection.prototype._end = function(packet) {
  this.stopHeartbeat();

  if (packet) {
    const data = json5.stringify(packet);
    this.transport.end(data);
  } else {
    this.transport.end();
  }
};

// Closed socket event handler
//
Connection.prototype._onSocketClose = function() {
  this.stopHeartbeat();
  this.emit('close', this);
  if (this.server) {
    this.server.emit('disconnect', this);
  }
};

// Socket error event handler
//   error - error that has occured
//
Connection.prototype._onSocketError = function(error) {
  this._end();
  this.emit('error', error, this);
};

// Process parsed incoming packets
//   packets - array of packets
//
Connection.prototype._processPacket = function(packet) {
  const keys = Object.keys(packet);
  if (keys.length === 0) {
    return;  // heartbeat packet
  }

  const kind = keys[0];
  if (!this.handshakeDone && kind !== 'handshake') {
    this._rejectPacket(packet, true);
    return;
  }

  const handler = PACKET_HANDLERS[kind];
  if (handler) {
    handler.call(this, packet, keys);
  } else {
    this._rejectPacket(packet);
  }
};

// Reject incoming packet
//   packet - rejected packet
//   fatal - if true, close the connection
//
Connection.prototype._rejectPacket = function(packet, fatal) {
  this.emit('packetRejected', packet, this);

  if (fatal) {
    this._end();
  }
};

// Process incoming handshake packet
//   packet - parsed packet
//   keys - array of packet keys
//
Connection.prototype._processHandshakePacket = function(packet, keys) {
  if (this.handshakeDone) {
    this._rejectPacket(packet, true);
    return;
  }

  if (packet.handshake[1]) {  // if there is an application name
    this._processHandshakeRequest(packet, keys);
  } else {
    this._processHandshakeResponse(packet, keys);
  }
};

// Process incoming handshake packet which is a handshake request
//   packet - parsed packet
//   keys - array of packet keys
//
Connection.prototype._processHandshakeRequest = function(packet, keys) {
  if (!this.server) {
    this._handshakeError(errors.ERR_NOT_A_SERVER);
    return;
  }

  const applicationName = packet.handshake[1];
  const application = this.server.applications[applicationName];

  if (!application) {
    this._handshakeError(errors.ERR_APP_NOT_FOUND);
    return;
  }

  this.application = application;

  let authStrategy = keys[1];
  const credentials = authStrategy && packet[authStrategy];
  authStrategy = authStrategy || 'anonymous';

  this.server.startSession(this, application, authStrategy, credentials,
    this._onSessionCreated.bind(this));
};

// Callback of authentication operation
//   error - error that has occured or null
//   username - user login or null
//   sessionId - session id
//
Connection.prototype._onSessionCreated = function(error, username, sessionId) {
  if (error) {
    this._handshakeError(errors.ERR_AUTH_FAILED);
    return;
  }

  this.username = username;
  this.handshakeDone = true;
  this.sessionId = sessionId;

  this.emit('client', sessionId, this);
  this.server.emit('connect', this);

  const packet = this.createPacket('handshake', null, 'ok', sessionId);
  this._send(packet);
};

// Process incoming handshake packet which is a handshake response
//   packet - parsed packet
//
Connection.prototype._processHandshakeResponse = function(packet) {
  const packetId = packet.handshake[0];
  const callback = this._callbacks[packetId];

  if (!callback) {
    this._rejectPacket(packet);
  }

  if (packet.ok) {
    delete this._callbacks[packetId];

    this.handshakeDone = true;
    this.application = this.client.application;

    callback(null, packet.ok);
  } else if (packet.error) {
    delete this._callbacks[packetId];
    callback(errors.RemoteError.fromJstpArray(packet.error));
  } else {
    this._rejectPacket(packet, true);
  }
};

// End the connection with handshake error
//   error - error that has occured
//
Connection.prototype._handshakeError = function(error) {
  const normalizedError = errors.RemoteError.getJstpArrayFor(error);
  const packet = this.createPacket('handshake', null, 'error', normalizedError);

  this._end(packet);
};

// Process incoming call packet
//   packet - parsed packet
//   keys - array of packet keys
//
Connection.prototype._processCallPacket = function(packet, keys) {
  const packetId = packet.call[0];
  const interfaceName = packet.call[1];
  const methodName = keys[1];
  const args = packet[methodName];

  const callback = this._remoteCallbackWrapper.bind(this, packetId);

  if (!args) {
    return callback(errors.ERR_INVALID_SIGNATURE);
  }

  try {
    this.application.callMethod(this,
      interfaceName, methodName, args, callback);
  } catch (error) {
    callback(errors.ERR_INTERNAL_API_ERROR);
    throw error;
  }
};

// Process incoming callback packet
//   packet - parsed packet
//
Connection.prototype._processCallbackPacket = function(packet) {
  const packetId = packet.callback[0];
  const callback = this._callbacks[packetId];

  if (callback) {
    delete this._callbacks[packetId];

    if (packet.ok) {
      return callback(null, ...packet.ok);
    } else if (packet.error) {
      return callback(errors.RemoteError.fromJstpArray(packet.error));
    }
  }
  this._rejectPacket(packet);
};

// Process incoming event packet
//   packet - parsed packet
//   keys - array of packet keys
//
Connection.prototype._processEventPacket = function(packet, keys) {
  const interfaceName = packet.event[1];
  const eventName = keys[1];
  const eventArgs = packet[eventName];

  this.emit('event', interfaceName, eventName, eventArgs);

  const remoteProxy = this.remoteProxies[interfaceName];
  if (remoteProxy) {
    remoteProxy._emitLocal(eventName, eventArgs);
  }
};

// Process incoming inspect packet
//   packet - parsed packet
//
Connection.prototype._processInspectPacket = function(packet) {
  const packetId = packet.inspect[0];
  const interfaceName = packet.inspect[1];

  const methods = this.application.getMethods(interfaceName);
  if (methods) {
    this.callback(packetId, null, methods);
  } else {
    this.callback(packetId, errors.ERR_INTERFACE_NOT_FOUND);
  }
};

// Process incoming ping packet
//   packet - parsed packet
//
Connection.prototype._processPingPacket = function(packet) {
  this.pong(packet.ping[0]);
};

// Process incoming pong packet
//   packet - parsed packet
//
Connection.prototype._processPongPacket = function(packet) {
  const packetId = packet.pong[0];
  const callback = this._callbacks[packetId];
  if (callback) {
    delete this._callbacks[packetId];
    callback();
  }
};

// Callback of functions invoked via call packets
// Signature: Connection#_remoteCallbackWrapper(packetId, error, ...result)
//   packetId - id of a packet to send callback for
//   error - error that has occured, if any
//   result - data to send back as a result
//
Connection.prototype._remoteCallbackWrapper = function(
  packetId, error, ...result
) {
  this.callback(packetId, error, result);
};

PACKET_HANDLERS = {
  handshake: Connection.prototype._processHandshakePacket,
  call:      Connection.prototype._processCallPacket,
  callback:  Connection.prototype._processCallbackPacket,
  event:     Connection.prototype._processEventPacket,
  inspect:   Connection.prototype._processInspectPacket,
  ping:      Connection.prototype._processPingPacket,
  pong:      Connection.prototype._processPongPacket
};
