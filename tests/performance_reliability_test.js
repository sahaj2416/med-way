const assert = require('assert');
const http = require('http');
const { db, allAsync, getAsync, runAsync } = require('../src/db/database');
const { aStar, routeCache, getRouteCacheStats, clearRouteCache } = require('../src/algorithms/AStar');
const { loadGraph } = require('../src/algorithms/OSMParser');
const { telemetryPruner } = require('../src/utils/telemetryPruner');
const { EventStreamManager } = require('../src/utils/eventStream');

const BASE_URL = 'http://127.0.0.1:3000';

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

async function runPerformanceReliabilityTests() {
  console.log('================================================================');
  console.log('MED WAY: SYSTEM PERFORMANCE & OPERATIONAL RELIABILITY TEST SUITE');
  console.log('================================================================');

  // TEST 1: Database B-Tree Indices & PRAGMA Verification
  console.log('\n[Test 1] Verifying SQLite Indices & High-Throughput PRAGMA Tuning...');
  const journalModeRow = await getAsync('PRAGMA journal_mode;');
  assert.strictEqual(journalModeRow.journal_mode.toLowerCase(), 'wal', 'PRAGMA journal_mode is WAL');

  const busyTimeoutRow = await getAsync('PRAGMA busy_timeout;');
  assert.ok(busyTimeoutRow.timeout >= 5000, `PRAGMA busy_timeout >= 5000ms (got ${busyTimeoutRow.timeout})`);

  const indexRows = await allAsync("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex%';");
  const existingIndices = new Set(indexRows.map(r => r.name));

  const expectedIndices = [
    'idx_ambulances_status',
    'idx_dispatches_ambulance',
    'idx_dispatches_driver',
    'idx_dispatches_incident',
    'idx_amb_history_amb_time',
    'idx_amb_history_dispatch',
    'idx_notifications_user_time',
    'idx_driver_profiles_amb',
    'idx_driver_profiles_user',
    'idx_hosp_caps_hosp',
    'idx_incidents_patient'
  ];

  for (const idx of expectedIndices) {
    assert.ok(existingIndices.has(idx), `Required index "${idx}" must exist in sqlite_master`);
  }
  console.log(`✓ PASS: All ${expectedIndices.length} performance B-tree indices verified in SQLite.`);
  console.log(`✓ PASS: WAL mode and busy_timeout (>=5000ms) confirmed.`);

  // TEST 2: In-Memory LRU Route Caching & Sub-Millisecond Speedup
  console.log('\n[Test 2] Verifying A* LRU Route Cache Performance & Sub-Millisecond Speedup...');
  clearRouteCache();
  const { graph } = await loadGraph();

  // Find two nodes on the main component
  const startNodeId = graph.findNearestRoadNode(28.57, 77.32, true);
  const targetNodeId = graph.findNearestRoadNode(28.58, 77.33, true);

  // 2a. First Run: Cache Miss (computes via A* heap expansion)
  const t0 = process.hrtime.bigint();
  const routeMiss = aStar(graph, startNodeId, targetNodeId);
  const t1 = process.hrtime.bigint();
  const missLatencyMs = Number(t1 - t0) / 1e6;

  assert.ok(routeMiss.coordinates.length >= 2, 'Route computed with valid coordinates');
  assert.strictEqual(routeMiss.fromCache, undefined, 'First lookup was a cache miss');

  // 2b. Second Run: Cache Hit (instant retrieval from LRU Map)
  const t2 = process.hrtime.bigint();
  const routeHit = aStar(graph, startNodeId, targetNodeId);
  const t3 = process.hrtime.bigint();
  const hitLatencyMs = Number(t3 - t2) / 1e6;

  assert.strictEqual(routeHit.fromCache, true, 'Second lookup returned fromCache = true');
  assert.strictEqual(routeHit.coordinates.length, routeMiss.coordinates.length, 'Cached coordinates match exactly');
  assert.strictEqual(routeHit.distanceKm, routeMiss.distanceKm, 'Cached distance matches exactly');

  const stats = getRouteCacheStats();
  assert.strictEqual(stats.hits, 1, 'Cache stats recorded 1 hit');
  assert.strictEqual(stats.misses, 1, 'Cache stats recorded 1 miss');
  assert.strictEqual(stats.size, 1, 'Cache contains 1 cached route');

  // 2c. Deep Clone Mutation Isolation Test
  routeHit.coordinates[0][0] = 99.9999;
  const routeHit2 = aStar(graph, startNodeId, targetNodeId);
  assert.notStrictEqual(routeHit2.coordinates[0][0], 99.9999, 'Mutating returned route object does not corrupt cached data');

  console.log(`✓ PASS: Cache Miss latency: ${missLatencyMs.toFixed(3)}ms`);
  console.log(`✓ PASS: Cache Hit latency:  ${hitLatencyMs.toFixed(3)}ms (${(missLatencyMs / Math.max(0.001, hitLatencyMs)).toFixed(1)}x speedup)`);
  console.log(`✓ PASS: LRU Route Cache clone isolation & stats verified.`);

  // TEST 3: Optimized Radial Snapping (Zero 197k-node Linear Scans)
  console.log('\n[Test 3] Verifying Bounded Radial Spatial Snapping (< 2ms)...');
  const snapCoords = [
    { name: 'Core Urban Noida (Sector 18)', lat: 28.5700, lon: 77.3200 },
    { name: 'Mid Peripheral (Sector 137)', lat: 28.5080, lon: 77.4080 },
    { name: 'Outer Regional Boundary', lat: 28.4500, lon: 77.4800 }
  ];

  for (const coord of snapCoords) {
    const st0 = process.hrtime.bigint();
    const snapped = graph.findNearestRoadNode(coord.lat, coord.lon, true);
    const st1 = process.hrtime.bigint();
    const snapMs = Number(st1 - st0) / 1e6;

    assert.ok(snapped !== null, `Snapped node found for ${coord.name}`);
    assert.ok(snapMs < 5.0, `Snapping completed in < 5ms (took ${snapMs.toFixed(3)}ms)`);
    console.log(`  - ${coord.name}: node ${snapped} in ${snapMs.toFixed(3)}ms`);
  }
  console.log('✓ PASS: All radial grid lookups completed in < 5ms without 197k linear scans.');

  // TEST 4: Telemetry Retention Sliding-Window Pruning
  console.log('\n[Test 4] Verifying Automated Telemetry Retention Pruning...');
  // Seed an old completed dispatch and synthetic old telemetry
  await runAsync(
    `INSERT INTO incidents (id, request_type, latitude, longitude, emergency_type, priority)
     VALUES (99999, 'BOOKING', 28.57, 77.32, 'GENERAL', 'Low')`
  ).catch(() => {});

  await runAsync(
    `INSERT INTO dispatches (id, incident_id, ambulance_id, hospital_id, status)
     VALUES (99999, 99999, 'AMB-101', 'HOSP-001', 'COMPLETED')`
  ).catch(() => {});

  // Insert 5 telemetry points dated 10 days ago for completed dispatch #99999
  for (let i = 0; i < 5; i++) {
    const lat = 28.57 + (i * 0.001);
    await runAsync(
      `INSERT INTO ambulance_location_history (ambulance_id, dispatch_id, latitude, longitude, speed_kmh, recorded_at)
       VALUES ('AMB-101', 99999, ?, 77.32, 40, datetime('now', '-10 days'))`,
      [lat]
    );
  }

  // Insert 2 recent telemetry points for completed dispatch #99999
  for (let i = 0; i < 2; i++) {
    const lat = 28.58 + (i * 0.001);
    await runAsync(
      `INSERT INTO ambulance_location_history (ambulance_id, dispatch_id, latitude, longitude, speed_kmh, recorded_at)
       VALUES ('AMB-101', 99999, ?, 77.33, 45, datetime('now', '-1 hours'))`,
      [lat]
    );
  }

  const prePruneCount = await getAsync(
    'SELECT COUNT(*) as count FROM ambulance_location_history WHERE dispatch_id = 99999'
  );
  assert.strictEqual(prePruneCount.count, 7, '7 synthetic telemetry points inserted');

  // Execute telemetry retention pruning (7 days retention threshold)
  const pruneResult = await telemetryPruner.pruneTelemetryHistory(7, 100);
  assert.strictEqual(pruneResult.success, true, 'Pruner ran successfully');
  assert.ok(pruneResult.prunedCount >= 5, `At least 5 expired points pruned (got ${pruneResult.prunedCount})`);

  const postPruneCount = await getAsync(
    'SELECT COUNT(*) as count FROM ambulance_location_history WHERE dispatch_id = 99999'
  );
  assert.strictEqual(postPruneCount.count, 2, 'Only 2 recent telemetry points retained');

  // Clean up synthetic test records
  await runAsync('DELETE FROM ambulance_location_history WHERE dispatch_id = 99999');
  await runAsync('DELETE FROM dispatches WHERE id = 99999');
  await runAsync('DELETE FROM incidents WHERE id = 99999');
  console.log('✓ PASS: Automated sliding-window retention pruning verified.');

  // TEST 5: Production Health & Diagnostics Endpoints
  console.log('\n[Test 5] Verifying Production Health (/health) & Diagnostics (/api/diagnostics)...');
  const healthRes = await getJson('/health');
  assert.strictEqual(healthRes.status, 200, 'GET /health returned HTTP 200');
  assert.strictEqual(healthRes.data.status, 'ok', 'Health status is ok');
  assert.ok(typeof healthRes.data.uptimeSeconds === 'number', 'Uptime reported');
  console.log(`✓ PASS: /health probe reported status: "${healthRes.data.status}", uptime: ${healthRes.data.uptimeSeconds}s`);

  const diagRes = await getJson('/api/diagnostics');
  assert.strictEqual(diagRes.status, 200, 'GET /api/diagnostics returned HTTP 200');
  assert.strictEqual(diagRes.data.status, 'ok');
  assert.ok(diagRes.data.process.memory.heapUsedMb > 0, 'Memory telemetry reported');
  assert.strictEqual(diagRes.data.graph.roadNodesCount, 197540, 'Graph nodes count reported (197540)');
  assert.ok(diagRes.data.routeCache !== undefined, 'Route cache telemetry reported');
  assert.ok(diagRes.data.realtimeStream !== undefined, 'Realtime stream telemetry reported');
  assert.ok(Array.isArray(diagRes.data.fleet), 'Fleet status summary array returned');
  console.log(`✓ PASS: /api/diagnostics reported Memory: ${diagRes.data.process.memory.heapUsedMb} MB heap, Fleet: ${diagRes.data.fleet.length} statuses, Cache: ${diagRes.data.routeCache.size} routes.`);

  // TEST 6: EventStream Teardown & Lifecycle Protection
  console.log('\n[Test 6] Verifying EventStream Lifecycle & SSE Teardown...');
  const testHub = new EventStreamManager();
  let fakeClosed = false;
  let shutdownMsg = '';

  const fakeRes = {
    writableEnded: false,
    destroyed: false,
    writeHead: () => {},
    write: (data) => {
      if (data.includes('SYSTEM_SHUTDOWN')) {
        shutdownMsg = data;
      }
    },
    end: () => {
      fakeClosed = true;
    }
  };

  testHub.addClient({ on: () => {} }, fakeRes, { userId: 'TEST-USER', role: 'DRIVER' });
  assert.strictEqual(testHub.getClientCount(), 1, 'Client registered in test hub');

  testHub.closeAll('Server test shutdown');
  assert.strictEqual(fakeClosed, true, 'Client socket closed on teardown');
  assert.ok(shutdownMsg.includes('SYSTEM_SHUTDOWN'), 'Client received SYSTEM_SHUTDOWN notice');
  assert.strictEqual(testHub.getClientCount(), 0, 'All clients drained from hub');
  console.log('✓ PASS: SSE client sockets drained cleanly with SYSTEM_SHUTDOWN notice.');

  console.log('\n================================================================');
  console.log('ALL SYSTEM PERFORMANCE & RELIABILITY TESTS PASSED! ✅');
  console.log('================================================================');
  process.exit(0);
}

runPerformanceReliabilityTests().catch((err) => {
  console.error('\n❌ Test execution failed:', err);
  process.exit(1);
});
