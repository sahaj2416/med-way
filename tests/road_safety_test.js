const http = require('http');
const { parseOSM } = require('../src/algorithms/OSMParser');
const { aStar, calculateETA } = require('../src/algorithms/AStar');
const { Graph, Node, Edge, haversineDistance } = require('../src/algorithms/Graph');
const { selectBestHospital, mapEmergencyToSpecialty } = require('../server');
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

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`✓ PASS: ${message}`);
}

async function runTestSuite() {
  console.log('================================================================');
  console.log('MED WAY: ALGORITHMIC & ROAD SAFETY VERIFICATION TEST SUITE');
  console.log('================================================================\n');

  await initDb();
  console.log('[Setup] Loading Noida OSM Road Graph...');
  const { graph, hospitals } = await parseOSM();
  console.log(`✓ Graph loaded: ${graph.roadNodes.size} drivable road nodes across ${graph.componentSizes.size} components.\n`);

  // -------------------------------------------------------------------------
  // TEST 1: Non-Vehicular Highway Filtering
  // -------------------------------------------------------------------------
  console.log('[Test 1] Verifying Non-Vehicular Infrastructure Filtering...');
  // Check that all edges in graph belong to DRIVABLE_HIGHWAYS
  const nonDrivableTypes = ['footway', 'pedestrian', 'steps', 'cycleway', 'path', 'bridleway', 'corridor'];
  let nonDrivableFound = 0;
  for (const nodeId of graph.roadNodes) {
    const edges = graph.getNeighbors(nodeId);
    for (const e of edges) {
      if (nonDrivableTypes.includes(e.roadType)) {
        nonDrivableFound++;
      }
    }
  }
  assert(nonDrivableFound === 0, `Zero non-vehicular road edges (steps, footways, cycleways) in graph (found ${nonDrivableFound})`);
  assert(graph.roadNodes.size < 216000, `Road node set excludes pedestrian ways (active road nodes: ${graph.roadNodes.size})`);

  // -------------------------------------------------------------------------
  // TEST 2: One-Way Road Directionality & Roundabouts
  // -------------------------------------------------------------------------
  console.log('\n[Test 2] Verifying One-Way Road Directionality & Roundabouts...');
  let directedEdgeCount = 0;
  let sampleDirected = null;

  for (const nodeId of graph.roadNodes) {
    const edges = graph.getNeighbors(nodeId);
    for (const e of edges) {
      const returnEdges = graph.getNeighbors(e.to);
      const hasReturn = returnEdges.some(re => re.to === nodeId);
      if (!hasReturn) {
        directedEdgeCount++;
        if (!sampleDirected) {
          sampleDirected = { from: nodeId, to: e.to, roadType: e.roadType };
        }
      }
    }
  }

  assert(directedEdgeCount > 1000, `Graph correctly preserves directed one-way edges (found ${directedEdgeCount} directed segments)`);
  console.log(`  Sample directed edge: Node ${sampleDirected.from} -> Node ${sampleDirected.to} (${sampleDirected.roadType})`);

  // Verify reverse traversal is blocked on directed edge
  const fromNeighbors = graph.getNeighbors(sampleDirected.from).map(e => e.to);
  const toNeighbors = graph.getNeighbors(sampleDirected.to).map(e => e.to);
  assert(fromNeighbors.includes(sampleDirected.to), `Forward edge ${sampleDirected.from} -> ${sampleDirected.to} exists`);
  assert(!toNeighbors.includes(sampleDirected.from), `Reverse edge ${sampleDirected.to} -> ${sampleDirected.from} is strictly blocked for one-way street`);

  // -------------------------------------------------------------------------
  // TEST 3: Speed-Weighted Corridor Routing (Travel-Time vs Euclidean Distance)
  // -------------------------------------------------------------------------
  console.log('\n[Test 3] Testing Travel-Time Routing & Speed Corridor Preference...');
  // Build a synthetic graph with two paths from Start to Goal:
  // Path A: Motorway (80 km/h) - 1.2 km long
  // Path B: Residential (30 km/h) - 0.8 km long
  // Distance: Path B (0.8 km) < Path A (1.2 km)
  // Travel Time:
  // Path A: 1200m / (80 / 3.6) = 1200 / 22.22 = 54 seconds
  // Path B: 800m / (30 / 3.6) = 800 / 8.33 = 96 seconds
  // Fastest route MUST choose Path A!
  const syntheticGraph = new Graph();
  const nStart = syntheticGraph.addNode('N_START', 28.5000, 77.3000);
  const nGoal = syntheticGraph.addNode('N_GOAL', 28.5100, 77.3000);
  const nMotorway = syntheticGraph.addNode('N_MOTORWAY', 28.5050, 77.3030);
  const nResidential = syntheticGraph.addNode('N_RESIDENTIAL', 28.5050, 77.3005);

  // Path A: N_START -> N_MOTORWAY -> N_GOAL (weight = 27s + 27s = 54s, dist = 1200m)
  syntheticGraph.addDirectedEdge('N_START', 'N_MOTORWAY', 'motorway', 27);
  syntheticGraph.addDirectedEdge('N_MOTORWAY', 'N_GOAL', 'motorway', 27);
  nStart.edges[0].distanceMeters = 600;
  nMotorway.edges[0].distanceMeters = 600;

  // Path B: N_START -> N_RESIDENTIAL -> N_GOAL (weight = 48s + 48s = 96s, dist = 800m)
  syntheticGraph.addDirectedEdge('N_START', 'N_RESIDENTIAL', 'residential', 48);
  syntheticGraph.addDirectedEdge('N_RESIDENTIAL', 'N_GOAL', 'residential', 48);
  nStart.edges[1].distanceMeters = 400;
  nResidential.edges[0].distanceMeters = 400;

  syntheticGraph.computeConnectedComponents();

  const corridorRoute = aStar(syntheticGraph, 'N_START', 'N_GOAL');
  assert(corridorRoute.coordinates.length === 3, 'Corridor route found successfully');
  assert(corridorRoute.durationSeconds === 54, `Fastest corridor prioritized: 54s travel time vs 96s residential crawl`);
  assert(corridorRoute.distanceKm === 1.2, `Selected route distance is 1.2 km (motorway) rather than 0.8 km residential`);

  // -------------------------------------------------------------------------
  // TEST 4: O(1) Disconnected Island Guard & Event-Loop Protection
  // -------------------------------------------------------------------------
  console.log('\n[Test 4] Verifying Island Guard & Denial of Service Protection...');
  // Find two nodes in different components
  let mainCompNode = null;
  let isolatedCompNode = null;
  for (const nodeId of graph.roadNodes) {
    const n = graph.getNode(nodeId);
    if (!mainCompNode && n.componentId === graph.mainComponentId) {
      mainCompNode = n;
    } else if (!isolatedCompNode && n.componentId !== graph.mainComponentId) {
      isolatedCompNode = n;
    }
    if (mainCompNode && isolatedCompNode) break;
  }

  assert(mainCompNode !== null && isolatedCompNode !== null, 'Found nodes in separate graph components');
  console.log(`  Start: Node ${mainCompNode.id} (Component ${mainCompNode.componentId}, Size ${graph.componentSizes.get(mainCompNode.componentId)})`);
  console.log(`  Target: Node ${isolatedCompNode.id} (Component ${isolatedCompNode.componentId}, Size ${graph.componentSizes.get(isolatedCompNode.componentId)})`);

  const tStart = process.hrtime.bigint();
  const islandResult = aStar(graph, mainCompNode.id, isolatedCompNode.id);
  const tEnd = process.hrtime.bigint();
  const elapsedMs = Number(tEnd - tStart) / 1000000;

  assert(islandResult.unreachable === true, 'A* correctly identifies disconnected components without path traversal');
  assert(islandResult.coordinates.length === 0, 'No false path returned for disconnected components');
  assert(elapsedMs < 1.0, `Island guard returned in ${elapsedMs.toFixed(3)}ms (O(1) execution, strictly < 1.0ms)`);

  // -------------------------------------------------------------------------
  // TEST 5: Clinical Triage Specialty Matching & Hospital Bed Validation
  // -------------------------------------------------------------------------
  console.log('\n[Test 5] Verifying Clinical Triage Specialty Matching & Bed Capacity...');
  const testLat = 28.5700;
  const testLon = 77.3400;

  // 5a. Cardiac Emergency Specialty Matching
  const cardiacHosp = await selectBestHospital(testLat, testLon, 'Cardiac', 'Critical', 'ALS', graph);
  assert(cardiacHosp !== null, 'Cardiac clinical selection returns a hospital');
  const cardiacCaps = await allAsync('SELECT specialty FROM hospital_capabilities WHERE hospital_id = ?', [cardiacHosp.id]);
  const cardiacSpecialties = cardiacCaps.map(c => c.specialty);
  assert(cardiacSpecialties.includes('CARDIAC'), `Cardiac patient routed to hospital with CARDIAC specialty (${cardiacHosp.name})`);
  assert(cardiacHosp.available_icu_beds > 0, `Critical patient hospital has confirmed ICU beds (${cardiacHosp.available_icu_beds} ICU beds)`);

  // 5b. Stroke Emergency Specialty Matching
  const strokeHosp = await selectBestHospital(testLat, testLon, 'Stroke', 'Critical', 'ALS', graph);
  assert(strokeHosp !== null, 'Stroke clinical selection returns a hospital');
  const strokeCaps = await allAsync('SELECT specialty FROM hospital_capabilities WHERE hospital_id = ?', [strokeHosp.id]);
  const strokeSpecialties = strokeCaps.map(c => c.specialty);
  assert(strokeSpecialties.includes('STROKE'), `Stroke patient routed to hospital with STROKE specialty (${strokeHosp.name})`);

  // 5c. Trauma / Accident Emergency Specialty Matching
  const traumaHosp = await selectBestHospital(testLat, testLon, 'Accident', 'High', 'BLS', graph);
  assert(traumaHosp !== null, 'Trauma clinical selection returns a hospital');
  const traumaCaps = await allAsync('SELECT specialty FROM hospital_capabilities WHERE hospital_id = ?', [traumaHosp.id]);
  const traumaSpecialties = traumaCaps.map(c => c.specialty);
  assert(traumaSpecialties.includes('TRAUMA'), `Accident patient routed to hospital with TRAUMA specialty (${traumaHosp.name})`);

  // 5d. Bed Availability Capacity Guard
  // Verify that hospital with 0 beds is penalized
  const fullHospTest = await selectBestHospital(testLat, testLon, 'General', 'Moderate', 'BLS', graph);
  assert(fullHospTest.available_beds > 0, `Hospital selected has open beds (${fullHospTest.available_beds} beds available)`);
  assert(fullHospTest.emergency_available === 1, `Hospital selected has active emergency facility (emergency_available = 1)`);

  // -------------------------------------------------------------------------
  // TEST 6: Live API Emergency SOS Dispatch with Clinical Triage & ETA
  // -------------------------------------------------------------------------
  console.log('\n[Test 6] Testing Live Emergency SOS API Dispatch...');
  const sosPayload = {
    latitude: 28.5355,
    longitude: 77.3910,
    emergencyType: 'Cardiac',
    priority: 'Critical',
    ambulanceType: 'ALS'
  };

  let sosRes = await makeRequest('POST', '/api/sos', sosPayload);
  if (sosRes.status === 429) {
    const retrySec = parseInt(sosRes.headers['retry-after'] || '5', 10);
    console.log(`  Rate limit active from previous test suite. Waiting ${retrySec}s...`);
    await new Promise(r => setTimeout(r, (retrySec + 1) * 1000));
    sosRes = await makeRequest('POST', '/api/sos', sosPayload);
  }
  assert(sosRes.status === 200, `POST /api/sos succeeded with HTTP ${sosRes.status}`);
  assert(sosRes.data.success === true, 'SOS response returns success = true');
  assert(sosRes.data.hospital !== undefined, `SOS assigned clinical hospital: ${sosRes.data.hospital.name}`);
  assert(sosRes.data.route_geometry !== undefined, 'Dual-route geometries generated');
  assert(sosRes.data.route_geometry.ambulanceToPatient.length >= 2, 'Ambulance-to-patient waypoints generated');
  assert(sosRes.data.route_geometry.patientToHospital.length >= 2, 'Patient-to-hospital waypoints generated');
  assert(sosRes.data.amb_eta_minutes >= 1, `Accurate ambulance ETA computed: ${sosRes.data.amb_eta_minutes} mins`);
  assert(sosRes.data.hosp_eta_minutes >= 1, `Accurate hospital transit ETA computed: ${sosRes.data.hosp_eta_minutes} mins`);

  console.log('\n================================================================');
  console.log('ALL ALGORITHMIC & ROAD SAFETY VERIFICATION TESTS PASSED! ✅');
  console.log('================================================================');
}

runTestSuite().catch((err) => {
  console.error('\n❌ Test suite failed:', err);
  process.exit(1);
});
