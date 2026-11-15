const { db, runAsync, getAsync, allAsync } = require('../db/database');
const { aStar, calculateETA } = require('../algorithms/AStar');
const { haversineDistance } = require('../algorithms/Graph');
const { rankHospitals, selectOptimalHospital } = require('../algorithms/ClinicalTriage');
const { dispatchMutex } = require('../utils/mutex');
const { eventStream } = require('../utils/eventStream');

let roadGraph = null;

function setRoadGraph(graph) {
  roadGraph = graph;
}

function getRoadGraph() {
  return roadGraph;
}

async function createNotification(userId, title, message, type = 'INFO') {
  try {
    await runAsync(
      'INSERT INTO notifications (user_id, title, message, type, is_read) VALUES (?, ?, ?, ?, 0)',
      [userId || 'SYSTEM', title, message, type]
    );
  } catch (err) {
    console.warn('Failed to insert notification:', err.message);
  }
}

async function fetchHospitalsWithCapabilities() {
  const query = `
    SELECT h.id, h.name, h.latitude, h.longitude, h.road_node_id, h.type,
           h.emergency_available, h.available_beds, h.available_icu_beds,
           COALESCE(GROUP_CONCAT(c.specialty), '') as capabilities
    FROM hospitals h
    LEFT JOIN hospital_capabilities c ON h.id = c.hospital_id
    WHERE h.latitude IS NOT NULL AND h.longitude IS NOT NULL
    GROUP BY h.id
  `;
  return await allAsync(query);
}

async function selectBestHospital(patientLat, patientLon, emergencyType, priority, preferredType, roadGraphInstance, hospitalType) {
  const hospitals = await fetchHospitalsWithCapabilities();
  if (!hospitals || hospitals.length === 0) {
    return null;
  }

  return selectOptimalHospital(
    patientLat,
    patientLon,
    hospitals,
    { emergencyType, priority, ambulanceType: preferredType, hospitalType },
    roadGraphInstance || roadGraph
  );
}

async function executeDispatch(req, res, mode, roadGraphOverride = null) {
  const currentGraph = roadGraphOverride || roadGraph;
  const payload = mode === 'BOOKING' ? (req.body || {}) : (req.method === 'GET' ? req.query : req.body);

  const lat = parseFloat(payload.lat || payload.latitude);
  const lon = parseFloat(payload.lon || payload.longitude);

  if (isNaN(lat) || isNaN(lon)) {
    return res.status(400).json({ error: 'Valid lat and lon coordinates are required' });
  }

  const priority = payload.priority || (mode === 'SOS' ? 'Critical' : 'High');
  const requestedHospitalId = payload.hospitalId || payload.hospital_id || null;
  const preferredType = payload.ambulanceType || payload.ambulance_type || null;
  const requestType = mode === 'SOS' ? 'SOS' : (payload.request_type || 'BOOKING');
  const emergencyType = payload.emergencyType || payload.emergency_type || (mode === 'SOS' ? 'SOS_ALERT' : 'GENERAL');
  const address = payload.address ? String(payload.address).trim() : null;
  const landmark = payload.landmark ? String(payload.landmark).trim() : null;
  const patientCount = parseInt(payload.patientCount || payload.patient_count || 1, 10);
  const medicalNotes = payload.medicalNotes || payload.medical_notes || null;
  const callerSessionId = payload.callerSessionId || payload.session_id || payload.patientId || payload.patient_id || req.headers['x-patient-id'] || null;
  const forceNewDispatch = (payload.forceNewDispatch === true || payload.forceNewDispatch === 'true' || payload.force_new_dispatch === true || payload.force_new_dispatch === 'true');

  // Active Dispatch Spatial-Temporal Deduplication Guard:
  // If an emergency mission is already active for these coordinates within the last 10 minutes,
  // return the existing dispatch to prevent accidental duplicate dispatches, unless explicitly forced.
  // When a caller session is provided, deduplication scopes to that patient session, allowing distinct
  // concurrent emergencies from different callers/devices at the same location to receive distinct vehicles.
  if (!forceNewDispatch) {
    let deduplicationSql = `
      SELECT d.id, d.incident_id, d.ambulance_id, d.hospital_id, d.driver_id, d.status,
              d.route_distance_km, d.estimated_eta_minutes, d.route_geometry_json,
              i.latitude as patient_lat, i.longitude as patient_lon,
              a.vehicle_number, a.ambulance_type, a.latitude as amb_lat, a.longitude as amb_lon,
              h.name as hospital_name, h.latitude as hosp_lat, h.longitude as hosp_lon
       FROM dispatches d
       JOIN incidents i ON d.incident_id = i.id
       JOIN ambulances a ON d.ambulance_id = a.id
       JOIN hospitals h ON d.hospital_id = h.id
       WHERE d.status IN ('ASSIGNED', 'ACCEPTED', 'EN_ROUTE', 'REACHED_PATIENT')
         AND abs(i.latitude - ?) < 0.0005
         AND abs(i.longitude - ?) < 0.0005
         AND i.created_at >= datetime('now', '-10 minutes')
    `;
    const deduplicationParams = [lat, lon];

    if (callerSessionId) {
      deduplicationSql += ' AND (i.caller_session_id = ? OR i.patient_id = ?)';
      deduplicationParams.push(callerSessionId, callerSessionId);
    }

    deduplicationSql += ' ORDER BY d.id DESC LIMIT 1';

    const existingActiveDispatch = await getAsync(deduplicationSql, deduplicationParams);

    if (existingActiveDispatch) {
      let routeGeo = null;
      try {
        routeGeo = JSON.parse(existingActiveDispatch.route_geometry_json);
      } catch (e) {
        routeGeo = {
          ambulanceToPatient: [{ lat: existingActiveDispatch.amb_lat, lon: existingActiveDispatch.amb_lon }, { lat, lon }],
          patientToHospital: [{ lat, lon }, { lat: existingActiveDispatch.hosp_lat, lon: existingActiveDispatch.hosp_lon }]
        };
      }

      return res.json({
        success: true,
        active_dispatch_exists: true,
        duplicate_prevented: true,
        message: 'Active emergency mission already en route to this location. Zero duplicate ambulances dispatched.',
        mode: mode,
        dispatch_id: existingActiveDispatch.id,
        incident_id: existingActiveDispatch.incident_id,
        patient: { lat: existingActiveDispatch.patient_lat, lon: existingActiveDispatch.patient_lon },
        ambulance: {
          id: existingActiveDispatch.ambulance_id,
          vehicle_number: existingActiveDispatch.vehicle_number,
          type: existingActiveDispatch.ambulance_type,
          lat: existingActiveDispatch.amb_lat,
          lon: existingActiveDispatch.amb_lon,
          etaMinutes: Math.max(1, Math.round(existingActiveDispatch.estimated_eta_minutes * 0.5))
        },
        hospital: {
          id: existingActiveDispatch.hospital_id,
          name: existingActiveDispatch.hospital_name,
          lat: existingActiveDispatch.hosp_lat,
          lon: existingActiveDispatch.hosp_lon
        },
        metrics: {
          distanceKm: existingActiveDispatch.route_distance_km,
          etaMinutes: existingActiveDispatch.estimated_eta_minutes
        },
        amb_eta_minutes: Math.max(1, Math.round(existingActiveDispatch.estimated_eta_minutes * 0.5)),
        hosp_eta_minutes: existingActiveDispatch.estimated_eta_minutes,
        route: routeGeo,
        route_geometry: routeGeo
      });
    }
  }

  // 1. Fetch available ambulances
  const availableAmbulances = await allAsync(
    'SELECT id, vehicle_number, ambulance_type, status, latitude, longitude, current_driver_id FROM ambulances WHERE status = "AVAILABLE"'
  );

  if (!availableAmbulances || availableAmbulances.length === 0) {
    return res.status(404).json({ error: 'No ambulances are currently available' });
  }

  let matching = availableAmbulances;
  if (preferredType) {
    const typeMatches = availableAmbulances.filter((a) => a.ambulance_type.toUpperCase() === preferredType.toUpperCase());
    if (typeMatches.length > 0) {
      matching = typeMatches;
    }
  }

  matching.sort((a, b) => {
    const distA = haversineDistance(a.latitude, a.longitude, lat, lon);
    const distB = haversineDistance(b.latitude, b.longitude, lat, lon);
    return distA - distB;
  });

  // 2. Atomic Compare-And-Swap (CAS) Reservation Loop
  let chosenAmb = null;
  for (const candidate of matching) {
    const updateRes = await runAsync(
      `UPDATE ambulances 
       SET status = 'ASSIGNED', last_location_updated_at = CURRENT_TIMESTAMP 
       WHERE id = ? AND status = 'AVAILABLE'`,
      [candidate.id]
    );

    if (updateRes && updateRes.changes === 1) {
      chosenAmb = candidate;
      break;
    }
  }

  if (!chosenAmb) {
    return res.status(409).json({ error: 'All matching ambulances were claimed by concurrent emergencies' });
  }

  let chosenHosp = null;
  let bedReserved = false;
  const isCritical = (priority.toUpperCase() === 'CRITICAL');
  const requiresIcu = isCritical || (preferredType && (preferredType.toUpperCase().includes('ICU') || preferredType.toUpperCase().includes('ALS')));

  try {
    // 3. Resolve destination hospital via Clinical Triage Scoring & Atomic Bed Reservation
    const hospitalsList = await fetchHospitalsWithCapabilities();

    let rankedCandidates = [];
    if (requestedHospitalId) {
      const explicit = (hospitalsList || []).find((h) => String(h.id) === String(requestedHospitalId));
      if (explicit) {
        rankedCandidates.push(explicit);
      }
    }

    const clinicalRanking = rankHospitals(lat, lon, hospitalsList || [], {
      emergencyType,
      priority,
      ambulanceType: preferredType,
      hospitalType: payload.hospitalType || payload.hospital_type
    }, currentGraph);

    for (const r of clinicalRanking) {
      if (!rankedCandidates.some((c) => String(c.id) === String(r.id))) {
        rankedCandidates.push(r);
      }
    }

    for (const candidate of rankedCandidates) {
      // Atomic Compare-And-Swap Bed Reservation
      const reserveRes = await runAsync(
        `UPDATE hospitals
         SET available_beds = available_beds - 1,
             available_icu_beds = CASE WHEN ? = 1 AND available_icu_beds > 0 THEN available_icu_beds - 1 ELSE available_icu_beds END
         WHERE id = ? AND available_beds > 0`,
        [requiresIcu ? 1 : 0, candidate.id]
      );

      if (reserveRes && reserveRes.changes === 1) {
        chosenHosp = candidate;
        bedReserved = true;
        break;
      }
    }

    if (!chosenHosp) {
      throw new Error('All candidate emergency hospitals are at maximum capacity (0 available beds). Regional ER diversion active.');
    }

    // 4. Compute A* Dual-Route geometries with Road Safety & Directionality
    const patientRoadNode = currentGraph ? currentGraph.findNearestRoadNode(lat, lon, true) : null;
    const ambRoadNode = currentGraph ? currentGraph.findNearestRoadNode(chosenAmb.latitude, chosenAmb.longitude, true) : null;

    let hospRoadNode = null;
    if (currentGraph) {
      const hospInGraph = currentGraph.getHospital(String(chosenHosp.id));
      if (hospInGraph && hospInGraph.snappedNodeId) {
        hospRoadNode = hospInGraph.snappedNodeId;
      } else if (chosenHosp.road_node_id && currentGraph.roadNodes.has(String(chosenHosp.road_node_id))) {
        hospRoadNode = String(chosenHosp.road_node_id);
      } else {
        hospRoadNode = currentGraph.findNearestRoadNode(chosenHosp.latitude, chosenHosp.longitude, true);
      }
    }

    let ambToPatient = { coordinates: [], distanceKm: 0, durationMinutes: 0 };
    let patientToHosp = { coordinates: [], distanceKm: 0, durationMinutes: 0 };

    if (currentGraph && ambRoadNode && patientRoadNode) {
      ambToPatient = aStar(currentGraph, ambRoadNode, patientRoadNode);
    }
    if (currentGraph && patientRoadNode && hospRoadNode) {
      patientToHosp = aStar(currentGraph, patientRoadNode, hospRoadNode);
    }

    let ambToPatientPoints = [];
    if (ambToPatient.coordinates && ambToPatient.coordinates.length > 0) {
      ambToPatientPoints = [
        { lat: chosenAmb.latitude, lon: chosenAmb.longitude },
        ...ambToPatient.coordinates.map((pt) => ({ lat: pt[0], lon: pt[1] })),
        { lat, lon }
      ];
    } else {
      ambToPatientPoints = [
        { lat: chosenAmb.latitude, lon: chosenAmb.longitude },
        { lat, lon }
      ];
      ambToPatient.distanceKm = Math.round((haversineDistance(chosenAmb.latitude, chosenAmb.longitude, lat, lon) / 1000) * 100) / 100;
    }

    let patientToHospPoints = [];
    if (patientToHosp.coordinates && patientToHosp.coordinates.length > 0) {
      patientToHospPoints = [
        { lat, lon },
        ...patientToHosp.coordinates.map((pt) => ({ lat: pt[0], lon: pt[1] })),
        { lat: chosenHosp.latitude, lon: chosenHosp.longitude }
      ];
    } else {
      patientToHospPoints = [
        { lat, lon },
        { lat: chosenHosp.latitude, lon: chosenHosp.longitude }
      ];
      patientToHosp.distanceKm = Math.round((haversineDistance(lat, lon, chosenHosp.latitude, chosenHosp.longitude) / 1000) * 100) / 100;
    }

    const totalHospDistKm = patientToHosp.distanceKm;
    const ambEtaMinutes = Math.max(1, Math.round(calculateETA(ambToPatient.distanceKm, priority, ambToPatient.durationMinutes)));
    const hospEtaMinutes = Math.max(1, Math.round(calculateETA(totalHospDistKm, priority, patientToHosp.durationMinutes)));

    // Verify if callerSessionId corresponds to a registered user ID (to fulfill foreign key if so)
    let validUserPatientId = null;
    if (callerSessionId) {
      const userRow = await getAsync('SELECT id FROM users WHERE id = ?', [callerSessionId]);
      if (userRow) validUserPatientId = userRow.id;
    }

    // 5. Insert Incident
    const insertIncidentSql = `
      INSERT INTO incidents (
        patient_id, caller_session_id, request_type, latitude, longitude, road_node_id,
        address, landmark, emergency_type, priority, patient_count, medical_notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const incRes = await runAsync(
      insertIncidentSql,
      [validUserPatientId, callerSessionId, requestType, lat, lon, patientRoadNode, address, landmark, emergencyType, priority, patientCount, medicalNotes]
    );
    const incidentId = incRes.lastID;

    // 6. Resolve Driver ID
    const drvRow = await getAsync(
      'SELECT user_id FROM driver_profiles WHERE current_ambulance_id = ? AND on_duty = 1 LIMIT 1',
      [chosenAmb.id]
    );
    let driverId = drvRow ? drvRow.user_id : chosenAmb.current_driver_id || null;

    // 7. Insert Dispatch
    const routeGeometryJson = JSON.stringify({
      ambulanceToPatient: ambToPatientPoints,
      patientToHospital: patientToHospPoints
    });

    const insertDispatchSql = `
      INSERT INTO dispatches (
        incident_id, ambulance_id, hospital_id, driver_id, status,
        route_distance_km, estimated_eta_minutes, route_geometry_json
      ) VALUES (?, ?, ?, ?, 'ASSIGNED', ?, ?, ?)
    `;
    const dispRes = await runAsync(
      insertDispatchSql,
      [incidentId, chosenAmb.id, chosenHosp.id, driverId, totalHospDistKm, hospEtaMinutes, routeGeometryJson]
    );
    const dispatchId = dispRes.lastID;

    // Persist Notifications & Broadcast Real-Time SSE Events
    if (driverId) {
      createNotification(
        driverId,
        'EMERGENCY DISPATCH ASSIGNED',
        `Urgent: ${priority} emergency at (${lat.toFixed(4)}, ${lon.toFixed(4)}). Assigned vehicle ${chosenAmb.vehicle_number}.`,
        'EMERGENCY'
      );
    }
    createNotification(
      'USER-ADMIN-01',
      'NEW EMERGENCY DISPATCH',
      `Dispatch #${dispatchId} generated for ambulance ${chosenAmb.vehicle_number} to ${chosenHosp.name}.`,
      'DISPATCH'
    );

    const dispatchBroadcast = {
      dispatch_id: dispatchId,
      incident_id: incidentId,
      ambulance_id: chosenAmb.id,
      driver_id: driverId,
      patient: { lat, lon },
      hospital: { id: chosenHosp.id, name: chosenHosp.name, lat: chosenHosp.latitude, lon: chosenHosp.longitude },
      ambulance: {
        id: chosenAmb.id,
        vehicle_number: chosenAmb.vehicle_number,
        type: chosenAmb.ambulance_type,
        lat: chosenAmb.latitude,
        lon: chosenAmb.longitude,
        etaMinutes: ambEtaMinutes
      },
      route: {
        ambulanceToPatient: ambToPatientPoints,
        patientToHospital: patientToHospPoints
      },
      metrics: {
        distanceKm: totalHospDistKm,
        etaMinutes: hospEtaMinutes
      }
    };

    if (driverId) {
      eventStream.sendToUser(driverId, 'DISPATCH_ASSIGNED', dispatchBroadcast);
    }
    eventStream.broadcast('FLEET_UPDATE', {
      ambulance_id: chosenAmb.id,
      status: 'ASSIGNED',
      dispatch_id: dispatchId
    });
    eventStream.sendToRole('ADMIN', 'DISPATCH_CREATED', dispatchBroadcast);

    res.json({
      success: true,
      mode: mode,
      dispatch_id: dispatchId,
      incident_id: incidentId,
      patient: { lat, lon },
      ambulance: {
        id: chosenAmb.id,
        vehicle_number: chosenAmb.vehicle_number,
        type: chosenAmb.ambulance_type,
        lat: chosenAmb.latitude,
        lon: chosenAmb.longitude,
        distanceKm: ambToPatient.distanceKm,
        etaMinutes: ambEtaMinutes
      },
      hospital: {
        id: chosenHosp.id,
        name: chosenHosp.name,
        lat: chosenHosp.latitude,
        lon: chosenHosp.longitude
      },
      metrics: {
        distanceKm: totalHospDistKm,
        etaMinutes: hospEtaMinutes
      },
      amb_eta_minutes: ambEtaMinutes,
      hosp_eta_minutes: hospEtaMinutes,
      route: {
        ambulanceToPatient: ambToPatientPoints,
        patientToHospital: patientToHospPoints
      },
      route_geometry: {
        ambulanceToPatient: ambToPatientPoints,
        patientToHospital: patientToHospPoints
      }
    });
  } catch (err) {
    // Compensation Rollback: Release ambulance and bed if subsequent steps fail
    console.error('Dispatch processing error, rolling back allocations:', err);
    if (chosenAmb) {
      await runAsync('UPDATE ambulances SET status = "AVAILABLE" WHERE id = ?', [chosenAmb.id]).catch(() => {});
    }
    if (chosenHosp && bedReserved) {
      await runAsync(
        `UPDATE hospitals
         SET available_beds = available_beds + 1,
             available_icu_beds = CASE WHEN ? = 1 THEN available_icu_beds + 1 ELSE available_icu_beds END
         WHERE id = ?`,
        [requiresIcu ? 1 : 0, chosenHosp.id]
      ).catch(() => {});
    }
    res.status(500).json({ error: err.message || 'Dispatch processing failed' });
  }
}

function handleDispatchFlow(req, res, mode, roadGraphOverride = null) {
  dispatchMutex.runExclusive(() => executeDispatch(req, res, mode, roadGraphOverride)).catch((err) => {
    console.error('Unhandled mutex error in handleDispatchFlow:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'Internal dispatch error' });
    }
  });
}

module.exports = {
  setRoadGraph,
  getRoadGraph,
  createNotification,
  fetchHospitalsWithCapabilities,
  selectBestHospital,
  executeDispatch,
  handleDispatchFlow
};
