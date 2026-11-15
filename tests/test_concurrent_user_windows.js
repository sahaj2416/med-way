const http = require('http');

function postRequest(path, body = {}, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: 'localhost',
        port: 3000,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...headers
        }
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(raw) });
          } catch (e) {
            resolve({ status: res.statusCode, raw });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function getRequest(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: 'localhost',
        port: 3000,
        path,
        method: 'GET',
        headers
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(raw) });
          } catch (e) {
            resolve({ status: res.statusCode, raw });
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function runTest() {
  console.log('================================================================');
  console.log('TEST: TWO SEPARATE USER WINDOWS AT EXACT SAME GPS COORDINATES');
  console.log('================================================================');

  // 1. Authenticate as admin and reset fleet
  const loginRes = await postRequest('/api/auth/login', {
    email: 'admin@medway.com',
    password: 'admin123'
  });
  if (!loginRes.body || !loginRes.body.token) {
    throw new Error('Admin login failed');
  }
  const adminToken = loginRes.body.token;

  await postRequest(
    '/api/admin/ambulances/free-all',
    {},
    { Authorization: `Bearer ${adminToken}` }
  );
  console.log('✓ Fleet reset to AVAILABLE');

  // Exact same GPS coordinates for both user windows/devices
  const lat = 28.5355;
  const lon = 77.3910;

  // Window 1 Patient Session
  const session1 = 'PAT-WIN1-USER-' + Date.now();
  // Window 2 Patient Session
  const session2 = 'PAT-WIN2-USER-' + (Date.now() + 1);

  console.log(`\n[Scenario 1] User Window 1 triggers SOS at (${lat}, ${lon})...`);
  const res1 = await getRequest(
    `/api/sos?lat=${lat}&lon=${lon}&priority=Critical&patientId=${encodeURIComponent(session1)}`,
    { 'x-patient-id': session1 }
  );

  console.log(`-> Window 1 response: Dispatch #${res1.body.dispatch_id}, Ambulance: ${res1.body.ambulance.id} (${res1.body.ambulance.vehicle_number})`);
  if (!res1.body.success || !res1.body.ambulance) {
    throw new Error('Window 1 dispatch failed');
  }

  console.log(`\n[Scenario 2] User Window 2 triggers SOS at EXACT SAME (${lat}, ${lon})...`);
  const res2 = await getRequest(
    `/api/sos?lat=${lat}&lon=${lon}&priority=Critical&patientId=${encodeURIComponent(session2)}`,
    { 'x-patient-id': session2 }
  );

  console.log(`-> Window 2 response: Dispatch #${res2.body.dispatch_id}, Ambulance: ${res2.body.ambulance.id} (${res2.body.ambulance.vehicle_number})`);
  if (!res2.body.success || !res2.body.ambulance) {
    throw new Error('Window 2 dispatch failed');
  }

  // Verification 1: Different ambulances
  const amb1 = res1.body.ambulance.id;
  const amb2 = res2.body.ambulance.id;
  if (amb1 === amb2) {
    console.error(`❌ FAILURE: Window 1 and Window 2 received the same ambulance (${amb1})!`);
    process.exit(1);
  }
  console.log(`✓ SUCCESS: Window 1 and Window 2 received distinct ambulances: ${amb1} vs ${amb2}!`);

  // Verification 2: Window 1 accidental double click returns the SAME active dispatch without assigning a 3rd ambulance
  console.log(`\n[Scenario 3] User Window 1 re-clicks SOS at (${lat}, ${lon}) (accidental double click)...`);
  const res1Retry = await getRequest(
    `/api/sos?lat=${lat}&lon=${lon}&priority=Critical&patientId=${encodeURIComponent(session1)}`,
    { 'x-patient-id': session1 }
  );
  if (res1Retry.body.duplicate_prevented !== true || res1Retry.body.ambulance.id !== amb1) {
    console.error(`❌ FAILURE: Accidental retry did not return existing mission for Window 1!`);
    process.exit(1);
  }
  console.log(`✓ SUCCESS: Window 1 accidental double click intercepted. Zero duplicate vehicles created; returned existing active mission (${amb1}).`);

  // Verification 3: Check Admin Dashboard
  console.log(`\n[Scenario 4] Checking Admin Dashboard active missions...`);
  const adminDash = await getRequest('/api/admin/dashboard-data', {
    Authorization: `Bearer ${adminToken}`
  });
  const activeDispatches = adminDash.body.activeDispatches || [];
  const activeAmbIds = activeDispatches.map((d) => d.ambulance_id || d.ambulance?.id);
  console.log(`-> Admin Dashboard active dispatches: ${activeDispatches.length} active`);
  activeDispatches.forEach((d) => console.log(`   - Mission #${d.id}: Ambulance ${d.ambulance_id} [${d.vehicle_number}]`));

  if (!activeAmbIds.includes(amb1) || !activeAmbIds.includes(amb2)) {
    console.error(`❌ FAILURE: Admin dashboard does not list both active ambulances!`);
    process.exit(1);
  }
  console.log(`✓ SUCCESS: Admin Dashboard lists both distinct dispatches matching user screens!`);

  console.log('\n================================================================');
  console.log('ALL VERIFICATION CHECKS PASSED WITH 100% SUCCESS! ✅');
  console.log('================================================================');
}

runTest().catch((e) => {
  console.error(e);
  process.exit(1);
});
