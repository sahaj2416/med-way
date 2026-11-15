const express = require('express');
const { getAsync, allAsync, runAsync } = require('../db/database');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { eventStream } = require('../utils/eventStream');

const router = express.Router();

// List Drivers
router.get('/drivers', authenticateToken, requireRole('ADMIN', 'DRIVER'), async (req, res) => {
  const query = `
    SELECT u.id, u.name, u.email, dp.license_number, dp.current_ambulance_id, dp.on_duty
    FROM users u
    LEFT JOIN driver_profiles dp ON u.id = dp.user_id
    WHERE u.role = 'DRIVER'
  `;
  try {
    const rows = await allAsync(query);
    res.json({ success: true, drivers: rows || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Driver Online
router.post('/driver/online', authenticateToken, requireRole('DRIVER'), async (req, res) => {
  const driverId = req.user.id;
  const driverName = req.user.name;
  const { vehicle_number, ambulance_type, latitude, longitude } = req.body || {};

  if (!vehicle_number || !ambulance_type || latitude === undefined || longitude === undefined) {
    return res.status(400).json({
      success: false,
      error: 'vehicle_number, ambulance_type, latitude, and longitude are required'
    });
  }

  const latNum = parseFloat(latitude);
  const lonNum = parseFloat(longitude);

  if (isNaN(latNum) || isNaN(lonNum)) {
    return res.status(400).json({
      success: false,
      error: 'latitude and longitude must be valid numbers'
    });
  }

  try {
    const existingAmb = await getAsync('SELECT id FROM ambulances WHERE vehicle_number = ?', [vehicle_number]);
    const ambulanceId = existingAmb ? existingAmb.id : `AMB-${Date.now().toString(36).toUpperCase()}`;

    const upsertAmbSql = `
      INSERT INTO ambulances (id, vehicle_number, ambulance_type, status, current_driver_id, latitude, longitude, last_location_updated_at)
      VALUES (?, ?, ?, 'AVAILABLE', ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        vehicle_number = excluded.vehicle_number,
        ambulance_type = excluded.ambulance_type,
        status = CASE WHEN ambulances.status = 'ASSIGNED' THEN 'ASSIGNED' ELSE 'AVAILABLE' END,
        current_driver_id = ?,
        latitude = excluded.latitude,
        longitude = excluded.longitude,
        last_location_updated_at = CURRENT_TIMESTAMP
    `;

    await runAsync(upsertAmbSql, [ambulanceId, vehicle_number, ambulance_type, driverId, latNum, lonNum, driverId]);

    const updateProfileSql = `
      UPDATE driver_profiles
      SET current_ambulance_id = ?, on_duty = 1
      WHERE user_id = ?
    `;

    const profRes = await runAsync(updateProfileSql, [ambulanceId, driverId]);

    if (profRes.changes === 0) {
      const profileId = `DRV-PROF-${Date.now().toString(36).toUpperCase()}`;
      const insertProfileSql = `
        INSERT INTO driver_profiles (id, user_id, license_number, on_duty, current_ambulance_id)
        VALUES (?, ?, ?, 1, ?)
      `;
      await runAsync(insertProfileSql, [profileId, driverId, `DL-${driverId}`, ambulanceId]);
    }

    res.json({
      success: true,
      message: 'Driver is now online and available',
      ambulance: {
        id: ambulanceId,
        vehicle_number,
        ambulance_type,
        status: 'AVAILABLE',
        current_driver_id: driverId,
        latitude: latNum,
        longitude: lonNum
      },
      driver: {
        id: driverId,
        name: driverName
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Driver Offline
router.post('/driver/offline', authenticateToken, requireRole('DRIVER'), async (req, res) => {
  const driverId = req.user.id;

  const activeCheckSql = `
    SELECT d.id, d.status
    FROM dispatches d
    JOIN ambulances a ON d.ambulance_id = a.id
    WHERE (d.driver_id = ? OR a.current_driver_id = ?)
      AND d.status IN ('ASSIGNED', 'ACCEPTED', 'REACHED_PATIENT')
    LIMIT 1
  `;

  try {
    const activeDispatch = await getAsync(activeCheckSql, [driverId, driverId]);
    if (activeDispatch) {
      return res.status(409).json({
        success: false,
        error: `Cannot go offline while dispatch #${activeDispatch.id} is ${activeDispatch.status}. Please complete the trip first.`
      });
    }

    await runAsync('UPDATE ambulances SET status = "OFFLINE", current_driver_id = NULL WHERE current_driver_id = ?', [driverId]);
    await runAsync('UPDATE driver_profiles SET on_duty = 0 WHERE user_id = ?', [driverId]);

    res.json({
      success: true,
      message: 'Driver is now offline',
      driverId
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Driver Active Dispatch
router.get('/driver/active-dispatch', authenticateToken, requireRole('DRIVER'), async (req, res) => {
  const driverId = req.user.id;

  const query = `
    SELECT
      d.id AS dispatch_id,
      d.status AS dispatch_status,
      d.ambulance_id,
      d.hospital_id,
      d.driver_id,
      d.route_distance_km,
      d.estimated_eta_minutes,
      d.route_geometry_json,
      i.id AS incident_id,
      i.latitude AS patient_latitude,
      i.longitude AS patient_longitude,
      i.emergency_type,
      i.priority,
      i.address,
      i.landmark,
      h.name AS hospital_name,
      h.latitude AS hospital_latitude,
      h.longitude AS hospital_longitude
    FROM dispatches d
    JOIN incidents i ON d.incident_id = i.id
    JOIN hospitals h ON d.hospital_id = h.id
    WHERE (d.driver_id = ? OR d.ambulance_id IN (SELECT id FROM ambulances WHERE current_driver_id = ?))
      AND d.status IN ('ASSIGNED', 'ACCEPTED', 'REACHED_PATIENT')
    ORDER BY d.id DESC
    LIMIT 1
  `;

  try {
    const row = await getAsync(query, [driverId, driverId]);
    if (!row) {
      return res.json({ success: true, active: false, dispatch: null });
    }

    let parsedRoutes = { ambulanceToPatient: [], patientToHospital: [] };
    if (row.route_geometry_json) {
      try {
        parsedRoutes = JSON.parse(row.route_geometry_json);
      } catch (e) {}
    }

    const ambToPatient = parsedRoutes.ambulanceToPatient || [];
    const patientToHospital = parsedRoutes.patientToHospital || [];

    res.json({
      success: true,
      active: true,
      dispatch: {
        dispatch_id: row.dispatch_id,
        status: row.dispatch_status,
        emergency_type: row.emergency_type,
        priority: row.priority,
        address: row.address,
        landmark: row.landmark,
        route_distance_km: row.route_distance_km,
        estimated_eta_minutes: row.estimated_eta_minutes,
        patient: {
          latitude: row.patient_latitude,
          longitude: row.patient_longitude
        },
        hospital: {
          id: row.hospital_id,
          name: row.hospital_name,
          latitude: row.hospital_latitude,
          longitude: row.hospital_longitude
        },
        patientToHospital: patientToHospital,
        ambToPatient: ambToPatient,
        route_coordinates: {
          ambToPatient: ambToPatient,
          patientToHospital: patientToHospital,
          ambulanceToPatient: ambToPatient
        }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Driver Live Location Ingestion
router.post('/driver/location', authenticateToken, requireRole('DRIVER'), async (req, res) => {
  const driverId = req.user.id;
  const { latitude, longitude, speed_kmh } = req.body || {};
  const latNum = parseFloat(latitude);
  const lonNum = parseFloat(longitude);

  if (isNaN(latNum) || isNaN(lonNum)) {
    return res.status(400).json({ success: false, error: 'Valid latitude and longitude are required' });
  }

  try {
    const amb = await getAsync('SELECT id FROM ambulances WHERE current_driver_id = ?', [driverId]);
    if (!amb) {
      return res.status(404).json({ success: false, error: 'No active ambulance found for this driver' });
    }

    await runAsync(
      'UPDATE ambulances SET latitude = ?, longitude = ?, last_location_updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [latNum, lonNum, amb.id]
    );

    const activeDisp = await getAsync(
      'SELECT id FROM dispatches WHERE ambulance_id = ? AND status IN ("ASSIGNED", "ACCEPTED", "REACHED_PATIENT") ORDER BY id DESC LIMIT 1',
      [amb.id]
    );

    await runAsync(
      'INSERT INTO ambulance_location_history (ambulance_id, dispatch_id, latitude, longitude, speed_kmh) VALUES (?, ?, ?, ?, ?)',
      [amb.id, activeDisp ? activeDisp.id : null, latNum, lonNum, speed_kmh || 0]
    );

    const telemetryEvent = {
      ambulance_id: amb.id,
      driver_id: driverId,
      dispatch_id: activeDisp ? activeDisp.id : null,
      latitude: latNum,
      longitude: lonNum,
      speed_kmh: speed_kmh || 0,
      timestamp: new Date().toISOString()
    };

    if (activeDisp && activeDisp.id) {
      eventStream.sendToDispatch(activeDisp.id, 'TELEMETRY_UPDATE', telemetryEvent);
    }
    eventStream.sendToRole('ADMIN', 'TELEMETRY_UPDATE', telemetryEvent);

    res.json({
      success: true,
      message: 'Location telemetry updated',
      ambulance_id: amb.id,
      latitude: latNum,
      longitude: lonNum
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
