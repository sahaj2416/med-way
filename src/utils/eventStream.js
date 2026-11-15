/**
 * Zero-Dependency Real-Time Event Hub (Server-Sent Events / SSE)
 * Provides persistent push notifications for emergency dispatches,
 * live telemetry coordinates, and fleet status updates.
 */

class EventStreamManager {
  constructor() {
    this.clients = new Map();
    this.clientCounter = 0;

    // Send keep-alive heartbeats every 15 seconds to prevent proxy/browser timeouts
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, 15000);

    // Prevent timer from keeping Node process open on exit
    if (this.heartbeatInterval.unref) {
      this.heartbeatInterval.unref();
    }
  }

  addClient(req, res, metadata = {}) {
    const clientId = `client_${++this.clientCounter}_${Date.now()}`;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*'
    });

    res.write(`:connected clientId=${clientId}\n\n`);

    const clientInfo = {
      id: clientId,
      res,
      userId: metadata.userId || null,
      role: metadata.role ? String(metadata.role).toUpperCase() : 'GUEST',
      dispatchId: metadata.dispatchId ? String(metadata.dispatchId) : null,
      ambulanceId: metadata.ambulanceId ? String(metadata.ambulanceId) : null,
      connectedAt: Date.now()
    };

    this.clients.set(clientId, clientInfo);

    req.on('close', () => {
      this.removeClient(clientId);
    });

    return clientId;
  }

  removeClient(clientId) {
    if (this.clients.has(clientId)) {
      this.clients.delete(clientId);
    }
  }

  sendToClient(clientInfo, eventName, data) {
    try {
      if (clientInfo.res.writableEnded || clientInfo.res.destroyed) {
        this.removeClient(clientInfo.id);
        return;
      }
      clientInfo.res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (err) {
      this.removeClient(clientInfo.id);
    }
  }

  broadcast(eventName, data) {
    for (const clientInfo of this.clients.values()) {
      this.sendToClient(clientInfo, eventName, data);
    }
  }

  sendToRole(role, eventName, data) {
    const targetRole = String(role).toUpperCase();
    for (const clientInfo of this.clients.values()) {
      if (clientInfo.role === targetRole) {
        this.sendToClient(clientInfo, eventName, data);
      }
    }
  }

  sendToUser(userId, eventName, data) {
    const targetUserId = String(userId);
    for (const clientInfo of this.clients.values()) {
      if (clientInfo.userId === targetUserId) {
        this.sendToClient(clientInfo, eventName, data);
      }
    }
  }

  sendToDispatch(dispatchId, eventName, data) {
    const targetDispatchId = String(dispatchId);
    for (const clientInfo of this.clients.values()) {
      if (clientInfo.dispatchId === targetDispatchId || clientInfo.role === 'ADMIN') {
        this.sendToClient(clientInfo, eventName, data);
      }
    }
  }

  sendHeartbeat() {
    for (const clientInfo of this.clients.values()) {
      try {
        if (!clientInfo.res.writableEnded && !clientInfo.res.destroyed) {
          clientInfo.res.write(':keepalive\n\n');
        } else {
          this.removeClient(clientInfo.id);
        }
      } catch (e) {
        this.removeClient(clientInfo.id);
      }
    }
  }

  getClientCount() {
    return this.clients.size;
  }

  getDiagnostics() {
    const roleCounts = {};
    for (const client of this.clients.values()) {
      roleCounts[client.role] = (roleCounts[client.role] || 0) + 1;
    }
    return {
      connectedClients: this.clients.size,
      roles: roleCounts
    };
  }

  closeAll(reason = 'Server shutting down for maintenance') {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    for (const clientInfo of this.clients.values()) {
      try {
        if (!clientInfo.res.writableEnded && !clientInfo.res.destroyed) {
          clientInfo.res.write(`event: SYSTEM_SHUTDOWN\ndata: ${JSON.stringify({ reason })}\n\n`);
          clientInfo.res.end();
        }
      } catch (e) {}
    }
    this.clients.clear();
  }
}

const eventStream = new EventStreamManager();

module.exports = {
  EventStreamManager,
  eventStream
};
