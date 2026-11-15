const express = require('express');
const { getAsync, allAsync, runAsync, transactionAsync } = require('../db/database');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { eventStream } = require('../utils/eventStream');

const router = express.Router();

// Authenticated Fleet Reset
router.post('/ambulances/free-all', authenticateToken, requireRole('ADMIN'), async (req, res) => {
  try {
    let updatedCount = 0;
    await transactionAsync(async () => {
      await runAsync("UPDATE dispatches SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP WHERE status != 'COMPLETED'");
      const ambRes = await runAsync("UPDATE ambulances SET status = 'AVAILABLE', last_location_updated_at = CURRENT_TIMESTAMP");
      updatedCount = ambRes.changes;
    });

    eventStream.broadcast('FLEET_UPDATE', {
      action: 'ALL_FREED',
      status: 'AVAILABLE'
    });

    res.json({
      success: true,
      message: `All ambulances have been freed (${updatedCount} updated) and active dispatches marked as completed.`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin Dashboard Data
router.get('/dashboard-data', authenticateToken, requireRole('ADMIN'), async (req, res) => {
  const ambSql = `
    SELECT id, vehicle_number, ambulance_type AS type, status, latitude, longitude
    FROM ambulances
    ORDER BY id ASC
  `;

  const activeSql = `
    SELECT 
      d.id AS dispatch_id,
      d.status,
      d.ambulance_id,
      a.vehicle_number,
      d.driver_id,
      COALESCE(u.name, 'Unassigned') AS driver_name,
      d.hospital_id,
      h.name AS hospital_name,
      h.latitude AS hospital_lat,
      h.longitude AS hospital_lon,
      d.route_distance_km,
      d.estimated_eta_minutes,
      d.route_geometry_json,
      i.id AS incident_id,
      i.latitude AS patient_lat,
      i.longitude AS patient_lon,
      i.address,
      i.landmark,
      i.emergency_type,
      i.priority
    FROM dispatches d
    LEFT JOIN ambulances a ON d.ambulance_id = a.id
    LEFT JOIN users u ON d.driver_id = u.id
    LEFT JOIN hospitals h ON d.hospital_id = h.id
    LEFT JOIN incidents i ON d.incident_id = i.id
    WHERE d.status IN ('ASSIGNED', 'ACCEPTED', 'REACHED_PATIENT')
    ORDER BY d.id DESC
  `;

  const completedSql = `
    SELECT 
      d.id AS dispatch_id,
      d.status,
      d.ambulance_id,
      a.vehicle_number,
      d.driver_id,
      COALESCE(u.name, 'Unassigned') AS driver_name,
      i.emergency_type,
      i.priority,
      i.address,
      i.landmark,
      d.completed_at
    FROM dispatches d
    LEFT JOIN ambulances a ON d.ambulance_id = a.id
    LEFT JOIN users u ON d.driver_id = u.id
    LEFT JOIN incidents i ON d.incident_id = i.id
    WHERE d.status = 'COMPLETED'
    ORDER BY d.completed_at DESC, d.id DESC
    LIMIT 10
  `;

  const countSql = `SELECT COUNT(*) AS total_completed FROM dispatches WHERE status = 'COMPLETED'`;
  
  const hospSql = `
    SELECT id, name, latitude, longitude, type
    FROM hospitals
    WHERE latitude IS NOT NULL AND longitude IS NOT NULL
  `;

  try {
    const [ambulances, activeRows, completedRows, countRow, hospitals] = await Promise.all([
      allAsync(ambSql),
      allAsync(activeSql),
      allAsync(completedSql),
      getAsync(countSql),
      allAsync(hospSql)
    ]);

    const activeDispatches = (activeRows || []).map(row => {
      let routeGeometry = null;
      if (row.route_geometry_json) {
        try {
          routeGeometry = JSON.parse(row.route_geometry_json);
        } catch (e) {
          routeGeometry = null;
        }
      }
      return {
        ...row,
        id: row.dispatch_id,
        route_geometry: routeGeometry
      };
    });

    const completedDispatches = (completedRows || []).map(row => ({
      ...row,
      id: row.dispatch_id
    }));

    const totalCompletedCount = countRow ? countRow.total_completed : completedDispatches.length;

    res.json({
      success: true,
      ambulances: ambulances || [],
      hospitals: hospitals || [],
      activeDispatches,
      completedDispatches,
      totalCompletedCount
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
