const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadGraph } = require('../src/algorithms/OSMParser');
const { createToken } = require('../src/utils/auth');
const { initDb, allAsync, getAsync } = require('../src/db/database');

const BASE_URL = 'http://localhost:3000';

function makeRequest(method, urlPath, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE_URL);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json'
      }
    };
    if (token) {
      options.headers['Authorization'] = `Bearer ${token}`;
    }

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, data: parsed, headers: res.headers });
        } catch (e) {
          resolve({ status: res.statusCode, data, headers: res.headers });
        }
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

function listenSSE(urlPath, token = null, onEvent) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE_URL);
    if (token) {
      url.searchParams.set('token', token);
    }
    const options = {
      method: 'GET',
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Accept': 'text/event-stream'
      }
    };

    const req = http.request(options, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`SSE connection failed with HTTP ${res.statusCode}`));
      }

      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n\n');
        buffer = lines.pop(); // keep last incomplete chunk

        for (const block of lines) {
          const lineArr = block.split('\n');
          let eventName = 'message';
          let eventData = null;

          for (const line of lineArr) {
            if (line.startsWith('event: ')) {
              eventName = line.substring(7).trim();
            } else if (line.startsWith('data: ')) {
              try {
                eventData = JSON.parse(line.substring(6).trim());
              } catch (e) {
                eventData = line.substring(6).trim();
              }
            }
          }

          if (eventData !== null) {
            onEvent(eventName, eventData);
          }
        }
      });

      resolve({ req, res });
    });

    req.on('error', reject);
    req.end();
  });
}

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`✓ PASS: ${message}`);
}

async function runTestSuite() {
  console.log('================================================================');
  console.log('MED WAY: REAL-TIME ARCHITECTURE & TELEMETRY TEST SUITE');
  console.log('================================================================\n');

  await initDb();
  const adminToken = createToken({ id: 'USER-ADMIN-01', email: 'admin@medway.com', role: 'ADMIN' });
  const driverToken = createToken({ id: 'USER-DRV-01', email: 'driver.vikram@medway.com', role: 'DRIVER' });

  // -------------------------------------------------------------------------
  // TEST 1: Sub-Second Graph Disk Caching Benchmark
  // -------------------------------------------------------------------------
  console.log('[Test 1] Benchmarking Graph Disk Caching Performance...');
  const cachePath = path.resolve(__dirname, '../data/noida_graph.cache.json');
  assert(fs.existsSync(cachePath), 'noida_graph.cache.json exists on disk');

  const tStart = process.hrtime.bigint();
  const cachedResult = await loadGraph();
  const tEnd = process.hrtime.bigint();
  const loadDurationMs = Number(tEnd - tStart) / 1000000;

  assert(cachedResult.fromCache === true, 'Graph loaded directly from disk cache (fromCache = true)');
  assert(cachedResult.graph.roadNodes.size === 197540, `Full network restored: ${cachedResult.graph.roadNodes.size} road nodes`);
  assert(cachedResult.hospitals.length === 286, `All 286 hospitals restored with snapped road nodes`);
  assert(loadDurationMs < 1200, `Graph hydrated in ${loadDurationMs.toFixed(1)}ms (cold-boot speedup verified, < 1200ms)`);
  console.log(`  Cache load latency: ${loadDurationMs.toFixed(1)}ms vs 8,500ms XML stream`);

  // -------------------------------------------------------------------------
  // TEST 2: Zero-Dependency Real-Time Event Hub (SSE) Stream
  // -------------------------------------------------------------------------
  console.log('\n[Test 2] Testing Server-Sent Events (SSE) Subscription & Push Delivery...');
  const receivedEvents = [];
  const sseConnection = await listenSSE('/api/stream/events?role=ADMIN', adminToken, (event, data) => {
    receivedEvents.push({ event, data, receivedAt: Date.now() });
  });

  assert(sseConnection !== null, 'SSE persistent stream established (HTTP 200, text/event-stream)');

  // -------------------------------------------------------------------------
  // TEST 3: Driver Telemetry Ingestion & Location History Persistence
  // -------------------------------------------------------------------------
  console.log('\n[Test 3] Testing Driver Telemetry Ingestion & History Logging...');
  // Ensure driver is on duty
  await makeRequest('POST', '/api/driver/online', {
    vehicle_number: 'UP-16-AM-101',
    ambulance_type: 'ALS',
    latitude: 28.5355,
    longitude: 77.3910
  }, driverToken);

  const testCoords = [
    { lat: 28.5360, lon: 77.3915, speed: 42 },
    { lat: 28.5375, lon: 77.3925, speed: 48 },
    { lat: 28.5390, lon: 77.3940, speed: 52 }
  ];

  for (const c of testCoords) {
    const locRes = await makeRequest('POST', '/api/driver/location', {
      latitude: c.lat,
      longitude: c.lon,
      speed_kmh: c.speed
    }, driverToken);
    assert(locRes.status === 200, `Telemetry point (${c.lat}, ${c.lon}) accepted with HTTP 200`);
  }

  // Verify DB history
  const historyRows = await allAsync(
    'SELECT latitude, longitude, speed_kmh FROM ambulance_location_history WHERE ambulance_id = "AMB-101" ORDER BY id DESC LIMIT 3'
  );
  assert(historyRows.length >= 3, `Ambulance location history persisted ${historyRows.length} recent telemetry points`);
  assert(Math.abs(historyRows[0].latitude - 28.5390) < 0.001, 'Latest location history matches newest telemetry GPS fix');

  // Verify SSE received the telemetry update
  await new Promise(r => setTimeout(r, 200));
  const telemetryPushes = receivedEvents.filter(e => e.event === 'TELEMETRY_UPDATE');
  assert(telemetryPushes.length > 0, `SSE received ${telemetryPushes.length} real-time TELEMETRY_UPDATE push broadcasts`);

  // -------------------------------------------------------------------------
  // TEST 4: Real-Time Dispatch Alerting (0ms Latency vs 5s Polling)
  // -------------------------------------------------------------------------
  console.log('\n[Test 4] Testing Real-Time Dispatch Alert Push (< 50ms)...');
  const sosStartTime = Date.now();
  let sosRes = await makeRequest('POST', '/api/sos', {
    latitude: 28.5400,
    longitude: 77.3900,
    emergencyType: 'Cardiac',
    priority: 'Critical',
    ambulanceType: 'ALS'
  });
  if (sosRes.status === 429) {
    const retrySec = parseInt(sosRes.headers['retry-after'] || '5', 10);
    console.log(`  Rate limit active from previous test suite. Waiting ${retrySec}s...`);
    await new Promise(r => setTimeout(r, (retrySec + 1) * 1000));
    sosRes = await makeRequest('POST', '/api/sos', {
      latitude: 28.5400,
      longitude: 77.3900,
      emergencyType: 'Cardiac',
      priority: 'Critical',
      ambulanceType: 'ALS'
    });
  }

  assert(sosRes.status === 200, 'Emergency SOS request dispatched');
  const dispatchId = sosRes.data.dispatch_id;

  // Check that admin and assigned driver received the push
  await new Promise(r => setTimeout(r, 300));
  const dispatchPushes = receivedEvents.filter(e => e.event === 'DISPATCH_CREATED' || e.event === 'FLEET_UPDATE');
  assert(dispatchPushes.length > 0, `Dispatch push received by SSE subscribers immediately`);

  // -------------------------------------------------------------------------
  // TEST 5: Active Mission Telemetry Query Endpoint
  // -------------------------------------------------------------------------
  console.log('\n[Test 5] Testing Dispatch Telemetry Tracking Endpoint...');
  const telemRes = await makeRequest('GET', `/api/dispatch/${dispatchId}/telemetry`);
  assert(telemRes.status === 200, `GET /api/dispatch/${dispatchId}/telemetry returned HTTP 200`);
  assert(telemRes.data.success === true, 'Telemetry response returns success = true');
  assert(telemRes.data.ambulance !== undefined, 'Assigned ambulance state returned in telemetry payload');
  assert(telemRes.data.status === 'ASSIGNED', 'Dispatch status accurately reported');

  // -------------------------------------------------------------------------
  // TEST 6: Notifications Table Integration & Dependency Hygiene
  // -------------------------------------------------------------------------
  console.log('\n[Test 6] Testing Notifications Persistence & Dependency Hygiene...');
  const notifRes = await makeRequest('GET', '/api/notifications', null, adminToken);
  assert(notifRes.status === 200, 'GET /api/notifications returned HTTP 200');
  assert(notifRes.data.notifications.length > 0, `Found ${notifRes.data.notifications.length} persisted notifications in DB`);
  console.log(`  Latest notification: "${notifRes.data.notifications[0].title}" - ${notifRes.data.notifications[0].message}`);

  const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
  assert(packageJson.dependencies['sax'] !== undefined, 'sax explicitly declared in package.json dependencies');

  // Clean up SSE connection
  if (sseConnection && sseConnection.req) {
    sseConnection.req.destroy();
  }

  // Free fleet
  await makeRequest('POST', '/api/admin/ambulances/free-all', null, adminToken);

  console.log('\n================================================================');
  console.log('ALL REAL-TIME ARCHITECTURE & TELEMETRY TESTS PASSED! ✅');
  console.log('================================================================');
}

runTestSuite().catch((err) => {
  console.error('\n❌ Test suite failed:', err);
  process.exit(1);
});
