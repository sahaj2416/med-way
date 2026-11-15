const express = require('express');
const { getAsync, allAsync, runAsync, transactionAsync } = require('../db/database');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { createRateLimiter } = require('../utils/rateLimiter');
const { eventStream } = require('../utils/eventStream');
const { handleDispatchFlow, createNotification } = require('../services/dispatchService');

const router = express.Router();

const sosRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 30,
  message: 'Too many emergency requests. Please wait a minute before trying again.'
});

const ALLOWED_TRANSITIONS = {
  'ASSIGNED': ['ACCEPTED'],
  'ACCEPTED': ['REACHED_PATIENT'],
  'REACHED_PATIENT': ['COMPLETED']
};

// Emergency SOS (GET and POST)
router.get('/sos', sosRateLimiter, (req, res) => {
  handleDispatchFlow(req, res, 'SOS');
});

router.post('/sos', sosRateLimiter, (req, res) => {
  handleDispatchFlow(req, res, 'SOS');
});

// Clinical Booking
router.post('/book', sosRateLimiter, (req, res) => {
  handleDispatchFlow(req, res, 'BOOKING');
});

// Complete Dispatch
router.post('/dispatch/complete', authenticateToken, requireRole('ADMIN', 'DRIVER'), async (req, res) => {
  const payload = req.body || req.query;
  const dispatchId = payload.dispatch_id || payload.dispatchId || payload.id;

  if (!dispatchId) {
    return res.status(400).json({ success: false, error: 'dispatch_id is required' });
  }

  try {
    const dispatch = await getAsync('SELECT id, ambulance_id, status, driver_id FROM dispatches WHERE id = ?', [dispatchId]);
    if (!dispatch) {
      return res.status(404).json({ success: false, error: `Dispatch ${dispatchId} not found` });
    }

    if (req.user.role !== 'ADMIN' && dispatch.driver_id && dispatch.driver_id !== req.user.id) {
      return res.status(403).json({ success: false, error: 'Forbidden: you are not assigned to this dispatch' });
    }

    await transactionAsync(async () => {
      await runAsync('UPDATE dispatches SET status = "COMPLETED", completed_at = CURRENT_TIMESTAMP WHERE id = ?', [dispatchId]);
      await runAsync('UPDATE ambulances SET status = "AVAILABLE" WHERE id = ?', [dispatch.ambulance_id]);
    });

    eventStream.sendToDispatch(dispatchId, 'STATUS_UPDATE', {
      dispatch_id: dispatch.id,
      status: 'COMPLETED',
      ambulance_id: dispatch.ambulance_id
    });
    eventStream.sendToRole('ADMIN', 'STATUS_UPDATE', {
      dispatch_id: dispatch.id,
      status: 'COMPLETED',
      ambulance_id: dispatch.ambulance_id
    });
    eventStream.sendToRole('ADMIN', 'FLEET_UPDATE', {
      ambulance_id: dispatch.ambulance_id,
      status: 'AVAILABLE'
    });
    createNotification(
      dispatch.driver_id,
      'DISPATCH COMPLETED',
      `Mission #${dispatchId} marked as completed. Vehicle is now AVAILABLE.`,
      'SUCCESS'
    );

    res.json({
      success: true,
      message: 'Dispatch completed successfully',
      dispatch_id: dispatch.id,
      ambulance_id: dispatch.ambulance_id,
      status: 'COMPLETED'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update Dispatch Status
router.post('/dispatch/update-status', authenticateToken, requireRole('DRIVER', 'ADMIN'), async (req, res) => {
  const payload = req.body || {};
  const dispatchId = payload.dispatchId || payload.dispatch_id || payload.id;
  const newStatus = (payload.newStatus || payload.status || '').toUpperCase();

  if (!dispatchId || !newStatus) {
    return res.status(400).json({ success: false, error: 'dispatchId and newStatus are required' });
  }

  const validStatuses = ['ACCEPTED', 'REACHED_PATIENT', 'COMPLETED'];
  if (!validStatuses.includes(newStatus)) {
    return res.status(400).json({ success: false, error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
  }

  try {
    const dispatch = await getAsync('SELECT id, ambulance_id, driver_id, status FROM dispatches WHERE id = ?', [dispatchId]);
    if (!dispatch) {
      return res.status(404).json({ success: false, error: `Dispatch ${dispatchId} not found` });
    }

    if (req.user.role !== 'ADMIN' && dispatch.driver_id && dispatch.driver_id !== req.user.id) {
      return res.status(403).json({ success: false, error: 'Forbidden: you are not assigned to this dispatch' });
    }

    if (dispatch.status === newStatus) {
      return res.json({
        success: true,
        message: `Dispatch is already ${newStatus}`,
        dispatch_id: dispatch.id,
        status: newStatus
      });
    }

    const allowedNext = ALLOWED_TRANSITIONS[dispatch.status] || [];
    if (!allowedNext.includes(newStatus)) {
      return res.status(400).json({
        success: false,
        error: `Cannot transition dispatch from '${dispatch.status}' to '${newStatus}'. Allowed: [${allowedNext.join(', ')}]`
      });
    }

    let timestampSql = '';
    if (newStatus === 'ACCEPTED') {
      timestampSql = ', accepted_at = CURRENT_TIMESTAMP';
    } else if (newStatus === 'REACHED_PATIENT') {
      timestampSql = ', reached_patient_at = CURRENT_TIMESTAMP';
    } else if (newStatus === 'COMPLETED') {
      timestampSql = ', completed_at = CURRENT_TIMESTAMP';
    }

    const updateDispatchSql = `UPDATE dispatches SET status = ?${timestampSql} WHERE id = ?`;

    await transactionAsync(async () => {
      await runAsync(updateDispatchSql, [newStatus, dispatchId]);
      if (newStatus === 'COMPLETED') {
        await runAsync('UPDATE ambulances SET status = "AVAILABLE" WHERE id = ?', [dispatch.ambulance_id]);
      }
    });

    eventStream.sendToDispatch(dispatchId, 'STATUS_UPDATE', {
      dispatch_id: dispatchId,
      status: newStatus,
      ambulance_id: dispatch.ambulance_id
    });
    eventStream.sendToRole('ADMIN', 'STATUS_UPDATE', {
      dispatch_id: dispatchId,
      status: newStatus,
      ambulance_id: dispatch.ambulance_id
    });
    if (newStatus === 'COMPLETED') {
      eventStream.sendToRole('ADMIN', 'FLEET_UPDATE', {
        ambulance_id: dispatch.ambulance_id,
        status: 'AVAILABLE'
      });
      createNotification(
        dispatch.driver_id,
        'DISPATCH COMPLETED',
        `Mission #${dispatchId} marked as completed. Vehicle is now AVAILABLE.`,
        'SUCCESS'
      );
    }

    res.json({
      success: true,
      message: newStatus === 'COMPLETED' ? 'Dispatch completed successfully' : `Dispatch status updated to ${newStatus}`,
      dispatch_id: dispatch.id,
      ambulance_id: dispatch.ambulance_id,
      status: newStatus
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Dispatch Live Telemetry
router.get('/dispatch/:id/telemetry', async (req, res) => {
  const dispatchId = req.params.id;
  try {
    const dispatch = await getAsync(
      `SELECT d.id, d.incident_id, d.status, d.ambulance_id, d.hospital_id, d.estimated_eta_minutes,
              d.route_distance_km, d.route_geometry_json,
              i.latitude as patient_lat, i.longitude as patient_lon, i.address as patient_address,
              i.emergency_type, i.priority,
              a.vehicle_number, a.ambulance_type,
              a.latitude as ambulance_lat, a.longitude as ambulance_lon,
              a.status as ambulance_status, a.last_location_updated_at,
              h.name as hospital_name, h.latitude as hospital_lat, h.longitude as hospital_lon
       FROM dispatches d
       LEFT JOIN incidents i ON d.incident_id = i.id
       LEFT JOIN ambulances a ON d.ambulance_id = a.id
       LEFT JOIN hospitals h ON d.hospital_id = h.id
       WHERE d.id = ?`,
      [dispatchId]
    );

    if (!dispatch) {
      return res.status(404).json({ success: false, error: 'Dispatch not found' });
    }

    const history = await allAsync(
      'SELECT latitude, longitude, speed_kmh, recorded_at FROM ambulance_location_history WHERE dispatch_id = ? ORDER BY id DESC LIMIT 50',
      [dispatchId]
    );

    let routeGeo = null;
    try {
      if (dispatch.route_geometry_json) {
        routeGeo = JSON.parse(dispatch.route_geometry_json);
      }
    } catch (e) {}

    const ambEta = Math.max(1, Math.round((dispatch.estimated_eta_minutes || 4) * 0.5));
    const hospEta = Math.max(1, Math.round(dispatch.estimated_eta_minutes || 6));

    res.json({
      success: true,
      dispatch_id: dispatch.id,
      incident_id: dispatch.incident_id,
      status: dispatch.status,
      patient: {
        lat: dispatch.patient_lat,
        lon: dispatch.patient_lon,
        address: dispatch.patient_address
      },
      ambulance: {
        id: dispatch.ambulance_id,
        vehicle_number: dispatch.vehicle_number || dispatch.ambulance_id,
        type: dispatch.ambulance_type || 'ALS',
        lat: dispatch.ambulance_lat,
        lon: dispatch.ambulance_lon,
        status: dispatch.ambulance_status,
        last_updated: dispatch.last_location_updated_at,
        etaMinutes: ambEta
      },
      hospital: {
        id: dispatch.hospital_id,
        name: dispatch.hospital_name || 'Assigned Hospital',
        lat: dispatch.hospital_lat,
        lon: dispatch.hospital_lon
      },
      metrics: {
        distanceKm: dispatch.route_distance_km || 0,
        etaMinutes: hospEta
      },
      amb_eta_minutes: ambEta,
      hosp_eta_minutes: hospEta,
      route: routeGeo || {
        ambulanceToPatient: [{ lat: dispatch.ambulance_lat, lon: dispatch.ambulance_lon }, { lat: dispatch.patient_lat, lon: dispatch.patient_lon }],
        patientToHospital: [{ lat: dispatch.patient_lat, lon: dispatch.patient_lon }, { lat: dispatch.hospital_lat, lon: dispatch.hospital_lon }]
      },
      route_geometry: routeGeo,
      recent_locations: history || []
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
