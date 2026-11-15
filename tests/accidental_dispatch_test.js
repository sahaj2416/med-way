const assert = require('assert');
const http = require('http');
const { db, allAsync, getAsync, runAsync } = require('../src/db/database');

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

async function runAccidentalDispatchTests() {
  console.log('================================================================');
  console.log('MED WAY: ACCIDENTAL SOS RE-CLICK & DUPLICATE PREVENTION TEST SUITE');
  console.log('================================================================');

  // Step 0: Ensure fleet is ready
  await runAsync('UPDATE ambulances SET status = "AVAILABLE"');
  const initialAvailable = await getAsync('SELECT COUNT(*) as count FROM ambulances WHERE status = "AVAILABLE"');
  console.log(`[Setup] Fleet initialized with ${initialAvailable.count} AVAILABLE vehicles.`);

  const testLat = 28.5680;
  const testLon = 77.3240;

  // TEST 1: Initial Booking / SOS Dispatch
  console.log('\n[Test 1] Dispatching Initial Emergency Ambulance...');
  const firstRes = await getJson(`/api/sos?lat=${testLat}&lon=${testLon}&priority=Critical`);
  assert.strictEqual(firstRes.status, 200, `Initial SOS status ${firstRes.status}`);
  assert.ok(firstRes.data.success, 'Initial SOS returns success');
  const initialDispatchId = firstRes.data.dispatch_id;
  const initialAmbId = firstRes.data.ambulance.id;
  assert.ok(initialDispatchId, 'Initial dispatch ID generated');
  assert.ok(initialAmbId, 'Ambulance assigned');
  console.log(`✓ PASS: Initial mission created -> Dispatch #${initialDispatchId} | Assigned Ambulance: ${initialAmbId}`);

  // Check fleet status: exactly 1 ambulance should be ASSIGNED
  const assignedCount1 = await getAsync('SELECT COUNT(*) as count FROM ambulances WHERE status = "ASSIGNED"');
  assert.strictEqual(assignedCount1.count, 1, 'Exactly 1 ambulance assigned in fleet');

  // TEST 2: Accidental SOS Re-Click (Deduplication Guard)
  console.log('\n[Test 2] User Accidental SOS Re-Click at Same Coordinates (Duplicate Guard)...');
  const secondRes = await getJson(`/api/sos?lat=${testLat}&lon=${testLon}&priority=Critical`);
  assert.strictEqual(secondRes.status, 200, 'Duplicate request returned HTTP 200');
  assert.strictEqual(secondRes.data.success, true);
  assert.strictEqual(secondRes.data.active_dispatch_exists, true, 'active_dispatch_exists flag returned true');
  assert.strictEqual(secondRes.data.duplicate_prevented, true, 'duplicate_prevented flag returned true');
  assert.strictEqual(secondRes.data.dispatch_id, initialDispatchId, 'Existing dispatch ID returned instead of new dispatch');
  assert.strictEqual(secondRes.data.ambulance.id, initialAmbId, 'Same ambulance returned');

  // Verify that zero additional ambulances were claimed!
  const assignedCount2 = await getAsync('SELECT COUNT(*) as count FROM ambulances WHERE status = "ASSIGNED"');
  assert.strictEqual(assignedCount2.count, 1, 'Fleet assignment remained 1 (ZERO duplicate ambulances claimed)');
  console.log('✓ PASS: Accidental SOS re-click prevented duplicate vehicle claim and returned active mission.');

  // TEST 3: Accidental Booking Re-Click via POST /api/book
  console.log('\n[Test 3] User Accidental Booking Re-Click via POST /api/book...');
  const bookRes = await postJson('/api/book', {
    lat: testLat,
    lon: testLon,
    hospitalId: firstRes.data.hospital.id,
    priority: 'Critical',
    emergencyType: 'Chest Pain',
    ambulanceType: 'ALS'
  });

  assert.strictEqual(bookRes.status, 200);
  assert.strictEqual(bookRes.data.active_dispatch_exists, true, 'Booking deduplication guard intercepted duplicate');
  assert.strictEqual(bookRes.data.duplicate_prevented, true);
  assert.strictEqual(bookRes.data.dispatch_id, initialDispatchId);

  const assignedCount3 = await getAsync('SELECT COUNT(*) as count FROM ambulances WHERE status = "ASSIGNED"');
  assert.strictEqual(assignedCount3.count, 1, 'Fleet count unchanged after duplicate booking attempt');
  console.log('✓ PASS: POST /api/book duplicate intercepted; active mission preserved.');

  // TEST 4: Multi-Casualty Disaster Override (forceNewDispatch = true)
  console.log('\n[Test 4] Multi-Casualty Disaster Explicit Override (forceNewDispatch = true)...');
  const forcedRes = await getJson(`/api/sos?lat=${testLat}&lon=${testLon}&priority=Critical&forceNewDispatch=true`);
  assert.strictEqual(forcedRes.status, 200);
  assert.strictEqual(forcedRes.data.success, true);
  const secondDispatchId = forcedRes.data.dispatch_id;
  const secondAmbId = forcedRes.data.ambulance.id;

  assert.notStrictEqual(secondDispatchId, initialDispatchId, 'New dispatch ID generated for explicit override');
  assert.notStrictEqual(secondAmbId, initialAmbId, 'Distinct second ambulance assigned');

  const assignedCount4 = await getAsync('SELECT COUNT(*) as count FROM ambulances WHERE status = "ASSIGNED"');
  assert.strictEqual(assignedCount4.count, 2, 'Exactly 2 distinct ambulances now assigned for multi-vehicle incident');
  console.log(`✓ PASS: Explicit override succeeded -> 2nd Dispatch #${secondDispatchId} | 2nd Ambulance: ${secondAmbId}`);

  // TEST 5: Active Mission Telemetry Ingestion & Re-Hydration
  console.log('\n[Test 5] Verifying Active Mission Telemetry Re-Hydration...');
  const telemRes = await getJson(`/api/dispatch/${initialDispatchId}/telemetry`);
  assert.strictEqual(telemRes.status, 200);
  assert.strictEqual(telemRes.data.success, true);
  assert.strictEqual(telemRes.data.ambulance.id, initialAmbId);
  console.log('✓ PASS: Telemetry endpoint returned active mission details for session re-hydration.');

  // Cleanup: Complete test dispatches and restore fleet
  await runAsync('UPDATE dispatches SET status = "COMPLETED" WHERE id IN (?, ?)', [initialDispatchId, secondDispatchId]);
  await runAsync('UPDATE ambulances SET status = "AVAILABLE"');
  console.log('\n[Cleanup] Test dispatches marked COMPLETED and fleet restored to AVAILABLE.');

  console.log('\n================================================================');
  console.log('ALL ACCIDENTAL DISPATCH & DUPLICATE PREVENTION TESTS PASSED! ✅');
  console.log('================================================================');
  process.exit(0);
}

runAccidentalDispatchTests().catch((err) => {
  console.error('\n❌ Test execution failed:', err);
  process.exit(1);
});
