const http = require('http');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

function makeRequest(urlPath, method = 'GET', data = null, customHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        ...customHeaders
      }
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve({ status: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, text: body });
        }
      });
    });

    req.on('error', (err) => reject(err));
    if (data) {
      req.write(JSON.stringify(data));
    }
    req.end();
  });
}

async function runTest() {
  console.log('================================================================');
  console.log('MED WAY: CONCURRENCY & RACE CONDITION VERIFICATION TEST SUITE');
  console.log('================================================================\n');

  // Step 1: Health Check & Admin Auth
  console.log('[1/4] Checking server status and obtaining Admin Token...');
  const bootstrapRes = await makeRequest('/api/bootstrap');
  if (bootstrapRes.status !== 200) {
    throw new Error(`Server not responding on ${BASE_URL}: HTTP ${bootstrapRes.status}`);
  }
  console.log(`✓ Connected to ${BASE_URL}. Total fleet: ${bootstrapRes.data.ambulances.length} ambulances.`);

  const adminLogin = await makeRequest('/api/auth/login', 'POST', {
    email: 'admin@medway.com',
    password: 'admin123'
  });
  if (adminLogin.status !== 200 || !adminLogin.data.token) {
    throw new Error('Failed to authenticate as admin in concurrency test');
  }
  const adminHeaders = { Authorization: `Bearer ${adminLogin.data.token}` };

  // Step 2: Reset fleet state
  console.log('\n[2/4] Resetting fleet to AVAILABLE via authenticated admin reset...');
  const resetRes = await makeRequest('/api/admin/ambulances/free-all', 'POST', null, adminHeaders);
  if (resetRes.status !== 200 || !resetRes.data.success) {
    throw new Error('Failed to reset ambulances');
  }
  console.log('✓ Fleet successfully reset. All active missions cleared.');

  // Step 3: Concurrent SOS Burst Test (Double-Dispatch Race Condition Test)
  console.log('\n[3/4] Launching 10 SIMULTANEOUS concurrent SOS requests to the exact same coordinates...');
  const testCoords = { lat: 28.5355, lon: 77.3910, priority: 'Critical' };
  const numConcurrent = 10;

  const promises = [];
  const startTime = Date.now();
  for (let i = 0; i < numConcurrent; i++) {
    promises.push(makeRequest('/api/sos', 'POST', {
      ...testCoords,
      medical_notes: `Concurrent test case #${i + 1}`,
      force_new_dispatch: true
    }));
  }

  const results = await Promise.all(promises);
  const duration = Date.now() - startTime;
  console.log(`✓ Received all ${numConcurrent} responses in ${duration}ms.\n`);

  const assignedAmbulanceIds = [];
  let successfulDispatches = 0;
  let conflictResponses = 0;

  results.forEach((res, index) => {
    if (res.status === 200 && res.data.ambulance) {
      successfulDispatches++;
      assignedAmbulanceIds.push(res.data.ambulance.id);
      console.log(`  Req #${index + 1}: SUCCESS -> Assigned Ambulance [${res.data.ambulance.id}] | Dispatch #${res.data.dispatch_id}`);
    } else {
      conflictResponses++;
      console.log(`  Req #${index + 1}: ${res.status} -> ${JSON.stringify(res.data || res.text)}`);
    }
  });

  // Verify uniqueness of assigned ambulances
  const uniqueAmbulanceIds = new Set(assignedAmbulanceIds);
  console.log(`\n--- Verification Metrics ---`);
  console.log(`Total Requests Sent:        ${numConcurrent}`);
  console.log(`Successful Dispatches:      ${successfulDispatches}`);
  console.log(`Unique Ambulances Assigned: ${uniqueAmbulanceIds.size}`);

  if (uniqueAmbulanceIds.size !== successfulDispatches) {
    console.error('\n❌ CRITICAL FAILURE: DUPLICATE AMBULANCE ASSIGNMENT DETECTED!');
    const counts = {};
    assignedAmbulanceIds.forEach(id => counts[id] = (counts[id] || 0) + 1);
    console.error('Duplicates breakdown:', Object.entries(counts).filter(([_, c]) => c > 1));
    process.exit(1);
  } else {
    console.log('\n✅ PASS: ZERO DUPLICATE DISPATCHES! Every concurrent emergency was assigned a distinct vehicle.');
  }

  // Step 4: Fleet Exhaustion Verification
  console.log('\n[4/4] Testing Fleet Exhaustion & Graceful Rejection under heavy concurrent load...');
  const secondBurstPromises = [];
  for (let i = 0; i < 12; i++) {
    secondBurstPromises.push(makeRequest('/api/sos', 'POST', {
      lat: 28.5700 + (i * 0.005),
      lon: 77.3500 + (i * 0.005),
      priority: 'High'
    }));
  }

  const secondResults = await Promise.all(secondBurstPromises);
  let secondSuccessful = 0;
  let exhaustedCount = 0;

  secondResults.forEach((res) => {
    if (res.status === 200 && res.data.ambulance) {
      secondSuccessful++;
      assignedAmbulanceIds.push(res.data.ambulance.id);
    } else if (res.status === 404 || res.status === 409) {
      exhaustedCount++;
    }
  });

  const totalUnique = new Set(assignedAmbulanceIds);
  console.log(`Second Burst: ${secondSuccessful} assigned, ${exhaustedCount} gracefully rejected (Fleet Capacity Reached).`);
  console.log(`Total Fleet Units Dispatched Across Both Tests: ${totalUnique.size} (Total uniqueness maintained: ${totalUnique.size === assignedAmbulanceIds.length})`);

  if (totalUnique.size !== assignedAmbulanceIds.length) {
    console.error('❌ Failure: Collisions occurred during fleet exhaustion.');
    process.exit(1);
  }

  // Reset back to available after test
  await makeRequest('/api/admin/ambulances/free-all', 'POST', null, adminHeaders);
  console.log('\n================================================================');
  console.log('ALL CONCURRENCY & RACE CONDITION TESTS PASSED SUCCESSFULLY! ✅');
  console.log('================================================================');
  process.exit(0);
}

runTest().catch((err) => {
  console.error('\n❌ Test suite execution failed:', err);
  process.exit(1);
});
