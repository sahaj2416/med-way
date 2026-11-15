const { haversineDistance } = require('./Graph');

/**
 * Standard Clinical Specialty Matrix
 */
const SPECIALTY_MAP = {
  CARDIAC: ['heart', 'cardiac', 'chest pain', 'cardio', 'cadiac', 'infarction'],
  STROKE: ['stroke', 'paralysis', 'brain', 'neuro', 'neurological', 'ischemic'],
  TRAUMA: ['accident', 'trauma', 'crash', 'fracture', 'burn', 'fall', 'bleeding', 'ortho'],
  PREGNANCY: ['pregnancy', 'maternity', 'labor', 'delivery', 'gynec', 'obstetric', 'birth'],
  GENERAL: ['general', 'fever', 'medical', 'other']
};

/**
 * Maps an incoming emergency descriptor or user selection to a clinical specialty category.
 */
function mapEmergencyToSpecialty(emergencyType) {
  if (!emergencyType) return null;
  const upper = String(emergencyType).toUpperCase().trim();

  for (const [specialty, keywords] of Object.entries(SPECIALTY_MAP)) {
    if (specialty === upper) return specialty;
    for (const kw of keywords) {
      if (upper.includes(kw.toUpperCase())) {
        return specialty;
      }
    }
  }
  return null;
}

/**
 * Scores a candidate hospital based on clinical capabilities, bed capacity,
 * network reachability, and transit time.
 */
function scoreHospital(patientLat, patientLon, hosp, options = {}, roadGraph = null) {
  const emergencyType = options.emergencyType || options.emergency_type || null;
  const priority = options.priority || 'High';
  const preferredType = options.ambulanceType || options.ambulance_type || null;
  const requestedHospitalType = options.hospitalType || options.hospital_type || null;

  const targetSpecialty = mapEmergencyToSpecialty(emergencyType);
  const isCritical = (priority.toUpperCase() === 'CRITICAL');
  const requiresIcu = isCritical || (preferredType && (preferredType.toUpperCase().includes('ICU') || preferredType.toUpperCase().includes('ALS')));

  const distMeters = haversineDistance(patientLat, patientLon, hosp.latitude, hosp.longitude);
  const distKm = Math.round((distMeters / 1000) * 10) / 10;
  // Baseline transit time in minutes assuming ~40 km/h average speed in urban traffic
  let score = (distKm / 40) * 60;

  // 1. Road Network Reachability Guard
  let isUnreachable = false;
  if (roadGraph && roadGraph.mainComponentId !== null) {
    const patientRoadNode = roadGraph.findNearestRoadNode(patientLat, patientLon, true);
    let hospRoadNode = null;
    if (hosp.road_node_id && roadGraph.roadNodes.has(String(hosp.road_node_id))) {
      hospRoadNode = String(hosp.road_node_id);
    } else {
      hospRoadNode = roadGraph.findNearestRoadNode(hosp.latitude, hosp.longitude, true);
    }

    if (patientRoadNode && hospRoadNode) {
      const pComp = roadGraph.getNode(patientRoadNode)?.componentId;
      const hComp = roadGraph.getNode(hospRoadNode)?.componentId;
      if (pComp && hComp && pComp !== hComp) {
        score += 50000;
        isUnreachable = true;
      }
    }
  }

  // 2. Emergency Department Availability
  const emergencyOpen = (hosp.emergency_available === 1 || hosp.emergency_available === true);
  if (!emergencyOpen) {
    score += 20000; // Severe penalty for non-emergency or closed facility
  }

  // 3. General Bed Availability
  const openBeds = (typeof hosp.available_beds === 'number') ? hosp.available_beds : 0;
  if (openBeds <= 0) {
    score += 15000; // Hospital is at full bed capacity (ER diversion risk)
  } else if (openBeds < 5) {
    score += 8; // Capacity strain penalty
  }

  // 4. Critical Care / ICU Availability
  const openIcuBeds = (typeof hosp.available_icu_beds === 'number') ? hosp.available_icu_beds : 0;
  if (requiresIcu) {
    if (openIcuBeds > 0) {
      score -= 10; // Bonus for confirmed ICU bed availability
    } else {
      score += 10000; // Heavy penalty for sending critical patient to hospital with 0 ICU beds
    }
  }

  // 5. Clinical Specialty Matching
  let rawCaps = hosp.capabilities || '';
  if (Array.isArray(rawCaps)) {
    rawCaps = rawCaps.join(',');
  }
  const caps = rawCaps.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  let specialtyMatched = false;

  if (targetSpecialty) {
    if (caps.includes(targetSpecialty)) {
      score -= 25; // 25-minute bonus: highly prioritize specialized clinical care
      specialtyMatched = true;
    } else {
      score += 20; // 20-minute penalty: avoid unequipped clinics for acute emergencies
    }
  }

  // 6. User Facility Preference Alignment (Government vs Private vs Multi-specialty)
  if (requestedHospitalType) {
    const userPref = String(requestedHospitalType).toUpperCase();
    const hospType = String(hosp.type || 'Private').toUpperCase();

    if (userPref === 'MULTI-SPECIALTY' || userPref === 'MULTISPECIALTY') {
      if (caps.length >= 3) {
        score -= 8;
      }
    } else if (userPref === hospType) {
      score -= 8;
    } else {
      score += 5;
    }
  }

  // Determine triage recommendation label
  let triageRecommendation = 'Viable Hospital';
  if (!emergencyOpen) {
    triageRecommendation = 'Emergency Closed';
  } else if (openBeds <= 0) {
    triageRecommendation = 'Capacity Exceeded';
  } else if (isUnreachable) {
    triageRecommendation = 'Network Unreachable';
  } else if (specialtyMatched && (!requiresIcu || openIcuBeds > 0)) {
    triageRecommendation = 'Optimal Specialty Center';
  } else if (specialtyMatched) {
    triageRecommendation = 'Specialty Matched (ICU Constrained)';
  } else if (openBeds < 5) {
    triageRecommendation = 'Capacity Strained';
  }

  return {
    hosp,
    score: Math.round(score * 10) / 10,
    distKm,
    etaMinutes: Math.max(1, Math.round((distKm / 35) * 60)),
    openBeds,
    openIcuBeds,
    emergencyOpen,
    specialtyMatched,
    targetSpecialty,
    capabilities: caps,
    isUnreachable,
    triageRecommendation
  };
}

/**
 * Evaluates and ranks all candidate hospitals for a patient context.
 */
function rankHospitals(patientLat, patientLon, hospitals, options = {}, roadGraph = null) {
  if (!hospitals || hospitals.length === 0) {
    return [];
  }

  const scored = hospitals.map(hosp => scoreHospital(patientLat, patientLon, hosp, options, roadGraph));
  scored.sort((a, b) => a.score - b.score);

  return scored.map((item, index) => {
    const isRecommended = (index === 0 && item.score < 10000);
    return {
      id: item.hosp.id,
      name: item.hosp.name,
      type: item.hosp.type || 'Private',
      lat: item.hosp.latitude,
      lon: item.hosp.longitude,
      latitude: item.hosp.latitude,
      longitude: item.hosp.longitude,
      roadNodeId: item.hosp.road_node_id,
      road_node_id: item.hosp.road_node_id,
      distanceKm: item.distKm,
      etaMinutes: item.etaMinutes,
      emergencyAvailable: item.emergencyOpen,
      emergency_available: item.emergencyOpen ? 1 : 0,
      availableBeds: item.openBeds,
      available_beds: item.openBeds,
      availableIcuBeds: item.openIcuBeds,
      available_icu_beds: item.openIcuBeds,
      capabilities: item.capabilities,
      isRecommended,
      specialtyMatched: item.specialtyMatched,
      targetSpecialty: item.targetSpecialty,
      triageRecommendation: isRecommended ? 'Optimal Clinical Match' : item.triageRecommendation,
      clinicalScore: item.score
    };
  });
}

/**
 * Selects the single best clinical hospital.
 */
function selectOptimalHospital(patientLat, patientLon, hospitals, options = {}, roadGraph = null) {
  const ranked = rankHospitals(patientLat, patientLon, hospitals, options, roadGraph);
  if (!ranked || ranked.length === 0) {
    return null;
  }
  return ranked[0];
}

module.exports = {
  SPECIALTY_MAP,
  mapEmergencyToSpecialty,
  scoreHospital,
  rankHospitals,
  selectOptimalHospital
};
