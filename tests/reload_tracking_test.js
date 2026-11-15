const assert = require('assert');
const http = require('http');

const BASE_URL = 'http://127.0.0.1:3000';

function getJson(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: body });
        }
      });
    }).on('error', reject);
  });
}

function postJson(path, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const url = new URL(path, BASE_URL);
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
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

async function runReloadTrackingTest() {
  console.log('================================================================');
  console.log('MED WAY: LIVE TRACKING RELOAD & SESSION RE-HYDRATION TEST');
  console.log('================================================================');

  const testLat = 28.5355;
  const testLon = 77.3910;

  console.log('\n[1/3] Triggering emergency SOS dispatch...');
  const sosRes = await postJson('/api/sos', {
    lat: testLat,
    lon: testLon,
    priority: 'Critical',
    force_new_dispatch: true
  });

  assert.strictEqual(sosRes.status, 200, `SOS status ${sosRes.status}`);
  const dispatchId = sosRes.data.dispatch_id;
  assert.ok(dispatchId, 'Dispatch ID generated');
  console.log(`✓ Initial dispatch generated: Mission #${dispatchId}`);

  console.log('\n[2/3] Querying telemetry re-hydration endpoint (/api/dispatch/:id/telemetry)...');
  const telemRes = await getJson(`/api/dispatch/${dispatchId}/telemetry`);
  assert.strictEqual(telemRes.status, 200, `Telemetry status ${telemRes.status}`);
  const payload = telemRes.data;

  // Verify all required structures for live tracking rehydration
  assert.strictEqual(payload.success, true, 'payload.success is true');
  assert.strictEqual(payload.dispatch_id, dispatchId, 'dispatch_id matches');

  // 1. Patient verification
  assert.ok(payload.patient, 'patient object present');
  assert.ok(typeof payload.patient.lat === 'number', 'patient.lat is a valid number');
  assert.ok(typeof payload.patient.lon === 'number', 'patient.lon is a valid number');
  assert.strictEqual(Math.round(payload.patient.lat * 1000) / 1000, Math.round(testLat * 1000) / 1000, 'patient coordinates match incident');

  // 2. Ambulance verification
  assert.ok(payload.ambulance, 'ambulance object present');
  assert.ok(payload.ambulance.id, 'ambulance.id present');
  assert.ok(payload.ambulance.vehicle_number, 'ambulance.vehicle_number present');
  assert.ok(typeof payload.ambulance.lat === 'number', 'ambulance.lat is valid');
  assert.ok(typeof payload.ambulance.lon === 'number', 'ambulance.lon is valid');
  assert.ok(payload.ambulance.etaMinutes >= 1, 'ambulance.etaMinutes >= 1');

  // 3. Hospital verification
  assert.ok(payload.hospital, 'hospital object present');
  assert.ok(payload.hospital.name, 'hospital.name present');
  assert.ok(typeof payload.hospital.lat === 'number', 'hospital.lat is valid');
  assert.ok(typeof payload.hospital.lon === 'number', 'hospital.lon is valid');

  // 4. Metrics verification
  assert.ok(payload.metrics, 'metrics object present');
  assert.ok(payload.metrics.distanceKm >= 0, 'metrics.distanceKm present');
  assert.ok(payload.metrics.etaMinutes >= 1, 'metrics.etaMinutes present');

  // 5. Dual Route Geometries (Ambulance-to-Patient AND Patient-to-Hospital)
  assert.ok(payload.route, 'route object present');
  assert.ok(Array.isArray(payload.route.ambulanceToPatient), 'ambulanceToPatient route waypoints array present');
  assert.ok(Array.isArray(payload.route.patientToHospital), 'patientToHospital route waypoints array present');
  assert.ok(payload.route.ambulanceToPatient.length >= 2, `ambulanceToPatient has ${payload.route.ambulanceToPatient.length} waypoints`);
  assert.ok(payload.route.patientToHospital.length >= 2, `patientToHospital has ${payload.route.patientToHospital.length} waypoints`);

  console.log(`✓ Telemetry payload verified:`);
  console.log(`  - Patient at (${payload.patient.lat}, ${payload.patient.lon})`);
  console.log(`  - Vehicle: ${payload.ambulance.vehicle_number} [${payload.ambulance.id}] at (${payload.ambulance.lat}, ${payload.ambulance.lon})`);
  console.log(`  - Hospital: ${payload.hospital.name}`);
  console.log(`  - Amb Route: ${payload.route.ambulanceToPatient.length} waypoints | Hosp Route: ${payload.route.patientToHospital.length} waypoints`);

  console.log('\n[3/3] Simulating browser client re-hydration...');
  // Verify that passing this payload directly into client draw logic has all required fields
  const ambPoints = payload.route.ambulanceToPatient.map(pt => [pt.lat, pt.lon]);
  const hospPoints = payload.route.patientToHospital.map(pt => [pt.lat, pt.lon]);
  assert.ok(ambPoints.length >= 2, 'Ambulance Leaflet polyline points valid');
  assert.ok(hospPoints.length >= 2, 'Hospital Leaflet polyline points valid');

  console.log('\n================================================================');
  console.log('LIVE TRACKING RELOAD TEST PASSED SUCCESSFULLY! ✅');
  console.log('================================================================');
  process.exit(0);
}

runReloadTrackingTest().catch((err) => {
  console.error('\n❌ Reload tracking test failed:', err);
  process.exit(1);
});
