const assert = require('assert');
const http = require('http');
const {
  mapEmergencyToSpecialty,
  scoreHospital,
  rankHospitals,
  selectOptimalHospital
} = require('../src/algorithms/ClinicalTriage');
const { db, runAsync, getAsync, allAsync } = require('../src/db/database');

const BASE_URL = 'http://127.0.0.1:3000';

function postJson(path, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const url = new URL(path, BASE_URL);
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...headers
        }
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(body) });
          } catch (e) {
            resolve({ status: res.statusCode, raw: body });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function getJson(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const req = http.request(
      url,
      {
        method: 'GET',
        headers
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(body) });
          } catch (e) {
            resolve({ status: res.statusCode, raw: body });
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function runTriageTests() {
  console.log('--- STARTING CLINICAL TRIAGE & BED ALLOCATION TEST SUITE ---');

  // TEST 1: Clinical Specialty Mapping
  console.log('[TEST 1] Verifying Clinical Specialty NLP Mapping...');
  assert.strictEqual(mapEmergencyToSpecialty('Acute Myocardial Infarction'), 'CARDIAC');
  assert.strictEqual(mapEmergencyToSpecialty('Severe Chest Pain'), 'CARDIAC');
  assert.strictEqual(mapEmergencyToSpecialty('Brain Stroke Paralysis'), 'STROKE');
  assert.strictEqual(mapEmergencyToSpecialty('Traffic Crash Fracture'), 'TRAUMA');
  assert.strictEqual(mapEmergencyToSpecialty('Severe bleeding after fall'), 'TRAUMA');
  assert.strictEqual(mapEmergencyToSpecialty('Labor contractions maternity'), 'PREGNANCY');
  assert.strictEqual(mapEmergencyToSpecialty('Unknown medical fever'), 'GENERAL');
  assert.strictEqual(mapEmergencyToSpecialty(null), null);
  console.log('✓ NLP Specialty mapping passed correctly for all clinical domains.');

  // TEST 2: Multi-Criteria Clinical Triage Scoring & Ranking
  console.log('[TEST 2] Verifying Hospital Scoring & ER Diversion Prevention...');
  const patientLat = 28.5700;
  const patientLon = 77.3200;

  const mockHospitals = [
    {
      id: 'HOSP-GEN-CLOSE',
      name: 'Nearby General Clinic',
      latitude: 28.5710, // ~100m away
      longitude: 77.3210,
      emergency_available: 1,
      available_beds: 10,
      available_icu_beds: 0,
      capabilities: 'GENERAL'
    },
    {
      id: 'HOSP-CARD-SPECIALTY',
      name: 'Super-Specialty Heart Hospital',
      latitude: 28.5800, // ~1.5 km away
      longitude: 77.3300,
      emergency_available: 1,
      available_beds: 15,
      available_icu_beds: 4,
      capabilities: 'GENERAL,CARDIAC,TRAUMA'
    },
    {
      id: 'HOSP-FULL-CAPACITY',
      name: 'Overcrowded Center',
      latitude: 28.5705,
      longitude: 77.3205,
      emergency_available: 1,
      available_beds: 0, // FULL BEDS
      available_icu_beds: 0,
      capabilities: 'GENERAL,CARDIAC'
    },
    {
      id: 'HOSP-CLOSED',
      name: 'Closed Facility',
      latitude: 28.5702,
      longitude: 77.3202,
      emergency_available: 0, // CLOSED
      available_beds: 50,
      available_icu_beds: 10,
      capabilities: 'GENERAL,CARDIAC'
    }
  ];

  // For a Critical Heart Attack:
  const rankedHeart = rankHospitals(patientLat, patientLon, mockHospitals, {
    emergencyType: 'Chest Pain Heart Attack',
    priority: 'Critical',
    ambulanceType: 'ICU'
  });

  assert.ok(rankedHeart.length === 4, 'All 4 candidate hospitals evaluated');
  // HOSP-CARD-SPECIALTY must be ranked #1 despite being slightly further away
  assert.strictEqual(rankedHeart[0].id, 'HOSP-CARD-SPECIALTY', 'Heart hospital ranked #1 for cardiac critical emergency');
  assert.strictEqual(rankedHeart[0].isRecommended, true);
  assert.strictEqual(rankedHeart[0].specialtyMatched, true);

  // Full capacity and Closed hospitals must be severely penalized
  const fullCapHosp = rankedHeart.find((h) => h.id === 'HOSP-FULL-CAPACITY');
  const closedHosp = rankedHeart.find((h) => h.id === 'HOSP-CLOSED');
  assert.ok(fullCapHosp.clinicalScore > 10000, 'Full capacity hospital must receive diversion penalty');
  assert.ok(closedHosp.clinicalScore > 10000, 'Closed facility must receive non-emergency penalty');
  console.log('✓ Clinical scoring prioritized specialized care and penalized diversion/closed centers.');

  // TEST 3: Stroke Emergency Routing
  console.log('[TEST 3] Verifying Stroke Emergency Routing...');
  const strokeHospitals = [
    {
      id: 'HOSP-TRAUMA-ONLY',
      name: 'Ortho & Trauma Hospital',
      latitude: 28.5720,
      longitude: 77.3220,
      emergency_available: 1,
      available_beds: 20,
      available_icu_beds: 5,
      capabilities: 'GENERAL,TRAUMA'
    },
    {
      id: 'HOSP-NEURO',
      name: 'Metro Neuro & Stroke Institute',
      latitude: 28.5850,
      longitude: 77.3350,
      emergency_available: 1,
      available_beds: 12,
      available_icu_beds: 3,
      capabilities: 'GENERAL,STROKE'
    }
  ];

  const optimalStroke = selectOptimalHospital(patientLat, patientLon, strokeHospitals, {
    emergencyType: 'Brain Stroke Paralysis',
    priority: 'Critical',
    ambulanceType: 'ICU'
  });
  assert.strictEqual(optimalStroke.id, 'HOSP-NEURO', 'Optimal hospital for stroke must be Neuro Institute');
  console.log('✓ Stroke clinical triage correctly selected Neuro institute.');

  // TEST 4: Atomic Compare-And-Swap Bed Allocation in Database
  console.log('[TEST 4] Verifying Atomic Bed CAS Decrement and Rollback...');
  const testHospId = 'TEST-HOSP-BEDS';
  await runAsync(
    `INSERT OR REPLACE INTO hospitals (id, name, latitude, longitude, emergency_available, available_beds, available_icu_beds, type)
     VALUES (?, ?, ?, ?, 1, 1, 1, 'Private')`,
    [testHospId, 'Bed Test Hospital', 28.5700, 77.3200]
  );

  // Initial beds = 1 available, 1 ICU
  let row = await getAsync('SELECT available_beds, available_icu_beds FROM hospitals WHERE id = ?', [testHospId]);
  assert.strictEqual(row.available_beds, 1);
  assert.strictEqual(row.available_icu_beds, 1);

  // Simulate First Reservation (Critical emergency requiring ICU)
  const res1 = await runAsync(
    `UPDATE hospitals
     SET available_beds = available_beds - 1,
         available_icu_beds = CASE WHEN ? = 1 AND available_icu_beds > 0 THEN available_icu_beds - 1 ELSE available_icu_beds END
     WHERE id = ? AND available_beds > 0`,
    [1, testHospId]
  );
  assert.strictEqual(res1.changes, 1, 'First reservation successfully claimed the last bed');

  row = await getAsync('SELECT available_beds, available_icu_beds FROM hospitals WHERE id = ?', [testHospId]);
  assert.strictEqual(row.available_beds, 0, 'Available beds reached 0');
  assert.strictEqual(row.available_icu_beds, 0, 'Available ICU beds reached 0');

  // Simulate Second Concurrent Reservation (should fail with changes === 0)
  const res2 = await runAsync(
    `UPDATE hospitals
     SET available_beds = available_beds - 1,
         available_icu_beds = CASE WHEN ? = 1 AND available_icu_beds > 0 THEN available_icu_beds - 1 ELSE available_icu_beds END
     WHERE id = ? AND available_beds > 0`,
    [1, testHospId]
  );
  assert.strictEqual(res2.changes, 0, 'Second reservation prevented over-allocation when beds = 0');

  // Simulate Rollback
  await runAsync(
    `UPDATE hospitals
     SET available_beds = available_beds + 1,
         available_icu_beds = CASE WHEN ? = 1 THEN available_icu_beds + 1 ELSE available_icu_beds END
     WHERE id = ?`,
    [1, testHospId]
  );
  row = await getAsync('SELECT available_beds, available_icu_beds FROM hospitals WHERE id = ?', [testHospId]);
  assert.strictEqual(row.available_beds, 1, 'Bed rollback restored capacity');
  assert.strictEqual(row.available_icu_beds, 1, 'ICU bed rollback restored capacity');

  // Clean up test hospital
  await runAsync('DELETE FROM hospitals WHERE id = ?', [testHospId]);
  console.log('✓ Atomic Bed CAS reservation and compensation rollback verified.');

  // TEST 5: Live API GET /api/hospitals with Triage Parameters
  console.log('[TEST 5] Testing GET /api/hospitals endpoint with triage query params...');
  const resApi = await getJson('/api/hospitals?lat=28.5700&lon=77.3200&emergencyType=Cardiac&priority=Critical&ambulanceType=ICU');
  assert.strictEqual(resApi.status, 200);
  assert.ok(Array.isArray(resApi.data.options), 'options array returned');
  assert.ok(resApi.data.options.length > 0, 'hospital options found');

  const topHosp = resApi.data.options[0];
  assert.ok(topHosp.id, 'Top hospital has ID');
  assert.ok(topHosp.name, 'Top hospital has name');
  assert.ok(typeof topHosp.availableBeds === 'number', 'availableBeds returned');
  assert.ok(typeof topHosp.availableIcuBeds === 'number', 'availableIcuBeds returned');
  assert.ok(topHosp.capabilities, 'capabilities returned');
  assert.ok(topHosp.triageRecommendation, 'triageRecommendation returned');
  assert.ok(topHosp.isRecommended === true, 'Top hospital isRecommended is true');
  console.log(`✓ GET /api/hospitals ranked: "${topHosp.name}" with recommendation "${topHosp.triageRecommendation}" and ${topHosp.availableBeds} beds (${topHosp.availableIcuBeds} ICU).`);

  // TEST 6: Live API POST /api/book Clinical Bed Allocation & Dispatch
  console.log('[TEST 6] Testing POST /api/book with live atomic bed allocation...');
  // Ensure an ambulance is available
  await runAsync('UPDATE ambulances SET status = "AVAILABLE" WHERE id = "AMB-001"');

  // Choose the top hospital from the previous step
  const targetHospitalId = topHosp.id;
  const initialHosp = await getAsync('SELECT available_beds, available_icu_beds FROM hospitals WHERE id = ?', [targetHospitalId]);

  const bookRes = await postJson('/api/book', {
    lat: 28.5700,
    lon: 77.3200,
    hospitalId: targetHospitalId,
    priority: 'Critical',
    emergencyType: 'Chest Pain Heart Attack',
    ambulanceType: 'ICU',
    patientCount: 1,
    address: 'Sector 18 Market, Noida',
    landmark: 'Near Metro Station'
  });

  assert.strictEqual(bookRes.status, 200, `Booking status ${bookRes.status}`);
  assert.ok(bookRes.data.success, 'Booking succeeded');
  assert.strictEqual(bookRes.data.hospital.id, targetHospitalId, 'Dispatched to requested/top hospital');

  // Verify bed count in database was atomically decremented
  const updatedHosp = await getAsync('SELECT available_beds, available_icu_beds FROM hospitals WHERE id = ?', [targetHospitalId]);
  assert.strictEqual(updatedHosp.available_beds, initialHosp.available_beds - 1, 'Hospital available_beds decremented by 1');
  if (initialHosp.available_icu_beds > 0) {
    assert.strictEqual(updatedHosp.available_icu_beds, initialHosp.available_icu_beds - 1, 'Hospital available_icu_beds decremented by 1');
  }

  // Restore the bed count
  await runAsync('UPDATE hospitals SET available_beds = ?, available_icu_beds = ? WHERE id = ?', [
    initialHosp.available_beds,
    initialHosp.available_icu_beds,
    targetHospitalId
  ]);
  // Restore ambulance AMB-001
  await runAsync('UPDATE ambulances SET status = "AVAILABLE" WHERE id = "AMB-001"');

  console.log('✓ POST /api/book successfully decremented hospital beds atomically on dispatch.');
  console.log('\n--- ALL CLINICAL TRIAGE & BED ALLOCATION TESTS PASSED! ---');
  process.exit(0);
}

runTriageTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
