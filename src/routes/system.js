const express = require('express');
const { db, getAsync, allAsync } = require('../db/database');
const { verifyToken } = require('../utils/auth');
const { optionalAuth, authenticateToken } = require('../middleware/auth');
const { eventStream } = require('../utils/eventStream');
const { telemetryPruner } = require('../utils/telemetryPruner');
const { getRouteCacheStats } = require('../algorithms/AStar');
const { rankHospitals } = require('../algorithms/ClinicalTriage');
const { getRoadGraph, fetchHospitalsWithCapabilities } = require('../services/dispatchService');

const router = express.Router();

// Production Liveness Probe
router.get('/health', async (req, res) => {
  try {
    await getAsync('SELECT 1');
    res.json({
      status: 'ok',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(503).json({
      status: 'degraded',
      error: err.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Production Observability & Diagnostics Endpoint
router.get('/api/diagnostics', async (req, res) => {
  try {
    const mem = process.memoryUsage();
    const routeCacheStats = getRouteCacheStats();
    const sseStats = eventStream.getDiagnostics();
    const prunerStats = telemetryPruner.getStats();
    const roadGraph = getRoadGraph();

    const fleetSummary = await allAsync('SELECT status, COUNT(*) as count FROM ambulances GROUP BY status');
    const dispatchSummary = await allAsync('SELECT status, COUNT(*) as count FROM dispatches GROUP BY status');

    res.json({
      status: 'ok',
      uptimeSeconds: Math.floor(process.uptime()),
      process: {
        nodeVersion: process.version,
        pid: process.pid,
        memory: {
          rssMb: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
          heapUsedMb: Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
          heapTotalMb: Math.round((mem.heapTotal / 1024 / 1024) * 10) / 10
        }
      },
      graph: {
        roadNodesCount: roadGraph ? roadGraph.roadNodes.size : 0,
        componentsCount: roadGraph ? roadGraph.componentSizes.size : 0,
        mainComponentId: roadGraph ? roadGraph.mainComponentId : null
      },
      routeCache: routeCacheStats,
      realtimeStream: sseStats,
      telemetryPruning: prunerStats,
      fleet: fleetSummary,
      dispatches: dispatchSummary,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// Zero-Dependency Real-Time Event Hub (Server-Sent Events / SSE)
router.get('/api/stream/events', optionalAuth, (req, res) => {
  let user = req.user;
  if (!user && req.query.token) {
    const verified = verifyToken(req.query.token);
    if (verified) {
      user = verified;
    }
  }

  const role = user ? user.role : (req.query.role || 'PATIENT');
  const userId = user ? user.id : (req.query.userId || null);
  const dispatchId = req.query.dispatchId || req.query.dispatch_id || null;

  eventStream.addClient(req, res, {
    userId,
    role,
    dispatchId
  });
});

// Notifications
router.get('/api/notifications', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    let notifications;
    if (req.user.role === 'ADMIN') {
      notifications = await allAsync(
        'SELECT id, user_id, title, message, type, is_read, created_at FROM notifications ORDER BY id DESC LIMIT 30'
      );
    } else {
      notifications = await allAsync(
        'SELECT id, user_id, title, message, type, is_read, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 30',
        [userId]
      );
    }
    res.json({ success: true, notifications: notifications || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Client Bootstrap Data (Ambulances & Hospitals)
router.get('/api/bootstrap', async (req, res) => {
  try {
    const ambQuery = `
      SELECT id, vehicle_number, ambulance_type, status, latitude, longitude
      FROM ambulances
    `;
    const hospQuery = `
      SELECT id, name, latitude, longitude, road_node_id, type
      FROM hospitals
      WHERE latitude IS NOT NULL AND longitude IS NOT NULL
    `;

    const [ambRows, hospRows] = await Promise.all([
      allAsync(ambQuery),
      allAsync(hospQuery)
    ]);

    const ambulances = (ambRows || []).map((amb) => ({
      id: amb.id,
      type: amb.ambulance_type,
      available: amb.status === 'AVAILABLE',
      status: amb.status,
      lat: amb.latitude,
      lon: amb.longitude
    }));

    const hospitals = (hospRows || []).map((hosp) => ({
      id: hosp.id,
      name: hosp.name,
      lat: hosp.latitude,
      lon: hosp.longitude,
      type: hosp.type,
      distanceKm: 0
    }));

    res.json({ ambulances, hospitals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Hospital Ranking via Clinical Triage
router.get('/api/hospitals', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);

  if (isNaN(lat) || isNaN(lon)) {
    return res.status(400).json({ error: 'Valid lat and lon query parameters are required' });
  }

  const priority = req.query.priority || 'High';
  const emergencyType = req.query.emergencyType || req.query.emergency_type || null;
  const hospitalType = req.query.hospitalType || req.query.hospital_type || null;
  const ambulanceType = req.query.ambulanceType || req.query.ambulance_type || null;

  try {
    const rows = await fetchHospitalsWithCapabilities();
    const options = rankHospitals(lat, lon, rows || [], {
      emergencyType,
      hospitalType,
      priority,
      ambulanceType
    }, getRoadGraph());

    res.json({ options });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
