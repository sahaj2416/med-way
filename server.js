const express = require('express');
const path = require('path');
const { db, initDb, allAsync, closeDb } = require('./src/db/database');
const { loadGraph } = require('./src/algorithms/OSMParser');
const { mapEmergencyToSpecialty, scoreHospital, rankHospitals, selectOptimalHospital } = require('./src/algorithms/ClinicalTriage');
const { eventStream } = require('./src/utils/eventStream');
const { telemetryPruner } = require('./src/utils/telemetryPruner');
const { setRoadGraph, getRoadGraph, selectBestHospital } = require('./src/services/dispatchService');

// Routers
const authRoutes = require('./src/routes/auth');
const systemRoutes = require('./src/routes/system');
const driverRoutes = require('./src/routes/driver');
const adminRoutes = require('./src/routes/admin');
const dispatchRoutes = require('./src/routes/dispatch');

// Global Process Crash Hardening
process.on('unhandledRejection', (reason, promise) => {
  console.error('[ProcessGuard] Unhandled Promise Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[ProcessGuard] Uncaught Exception:', err);
});

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS & Security Headers
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowedOrigins = ['http://localhost:3000', 'http://127.0.0.1:3000'];
  if (!origin || allowedOrigins.includes(origin) || origin.endsWith('.vercel.app')) {
    res.header('Access-Control-Allow-Origin', origin || '*');
  } else {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('X-Content-Type-Options', 'nosniff');
  res.header('X-Frame-Options', 'SAMEORIGIN');
  res.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Request Timeout Guard (15s threshold, bypasses SSE stream)
app.use((req, res, next) => {
  if (req.path === '/api/stream/events') {
    return next();
  }
  req.setTimeout(15000, () => {
    if (!res.headersSent) {
      res.status(504).json({ error: 'Request Timeout (15s threshold exceeded)' });
    }
  });
  next();
});

let initPromise = null;
async function ensureInitialized() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await initDb();
    const parsed = await loadGraph();
    const roadGraph = parsed.graph;
    setRoadGraph(roadGraph);

    const stmt = db.prepare('UPDATE hospitals SET road_node_id = ? WHERE id = ?');
    for (const h of parsed.hospitals) {
      if (h.snappedNodeId) {
        stmt.run(h.snappedNodeId, h.id);
      }
    }

    // Ensure any pre-seeded hospitals (e.g. HOSP-001 to HOSP-007) are snapped to the road network
    const remainingHospitals = await allAsync(
      'SELECT id, latitude, longitude FROM hospitals WHERE road_node_id IS NULL OR road_node_id LIKE "NODE-%"'
    );
    if (remainingHospitals) {
      for (const rh of remainingHospitals) {
        const snapped = roadGraph.findNearestRoadNode(rh.latitude, rh.longitude, true);
        if (snapped) {
          stmt.run(snapped, rh.id);
        }
      }
    }
    stmt.finalize();
  })();
  return initPromise;
}

// Ensure database and road graph are ready before serving requests (especially in serverless environments)
app.use(async (req, res, next) => {
  try {
    await ensureInitialized();
    next();
  } catch (err) {
    console.error('[InitGuard] Failed to initialize system:', err);
    res.status(500).json({ error: 'System initialization failed', message: err.message });
  }
});

// Static Web Frontends
app.use(express.static(path.join(__dirname, 'web')));

// Mount Domain Routers
app.use('/', systemRoutes);
app.use('/api/auth', authRoutes);
app.use('/api', driverRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api', dispatchRoutes);

let httpServer = null;
let isShuttingDown = false;

async function startServer() {
  await ensureInitialized();

  // Start Background Telemetry Retention Pruner (Hourly) only when running persistent server
  if (!process.env.VERCEL) {
    telemetryPruner.startSchedule();
  }

  httpServer = app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
  return httpServer;
}

function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[Lifecycle] Received ${signal}. Initiating graceful shutdown...`);

  const forceTimeout = setTimeout(() => {
    console.error('[Lifecycle] Graceful shutdown timeout (5s) expired. Forcing exit.');
    process.exit(1);
  }, 5000);
  forceTimeout.unref();

  telemetryPruner.stopSchedule();
  eventStream.closeAll(`Server shutting down (${signal})`);

  if (httpServer) {
    httpServer.close(async () => {
      console.log('[Lifecycle] HTTP server connections drained.');
      try {
        await closeDb();
        console.log('[Lifecycle] SQLite WAL database cleanly flushed & closed.');
        clearTimeout(forceTimeout);
        process.exit(0);
      } catch (dbErr) {
        console.error('[Lifecycle] Error closing database:', dbErr);
        clearTimeout(forceTimeout);
        process.exit(1);
      }
    });
  } else {
    closeDb().finally(() => process.exit(0));
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

if (require.main === module) {
  startServer().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}

module.exports = {
  app,
  startServer,
  gracefulShutdown,
  selectBestHospital,
  mapEmergencyToSpecialty,
  scoreHospital,
  rankHospitals,
  selectOptimalHospital,
  telemetryPruner
};
