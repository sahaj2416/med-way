const http = require('http');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const reqOptions = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    };

    const req = http.request(reqOptions, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, text: body });
        }
      });
    });

    req.on('error', reject);
    if (options.body) {
      req.write(JSON.stringify(options.body));
    }
    req.end();
  });
}

async function runSecurityTests() {
  console.log('================================================================');
  console.log('MED WAY: SECURITY & ACCESS CONTROL VERIFICATION TEST SUITE');
  console.log('================================================================\n');

  let passed = 0;
  let total = 0;

  function assert(condition, message) {
    total++;
    if (!condition) {
      console.error(`❌ FAIL: ${message}`);
      throw new Error(message);
    }
    passed++;
    console.log(`✓ PASS: ${message}`);
  }

  // TEST 1: Unauthenticated Access to God-Mode Admin Endpoints
  console.log('[Test 1] Testing Unauthenticated Access to Protected Admin Endpoints...');
  const unauthFreeAll = await request('/api/admin/ambulances/free-all', { method: 'POST' });
  assert(unauthFreeAll.status === 401, 'Unauthenticated POST /api/admin/ambulances/free-all returns HTTP 401');

  const unauthDashboard = await request('/api/admin/dashboard-data');
  assert(unauthDashboard.status === 401, 'Unauthenticated GET /api/admin/dashboard-data returns HTTP 401');

  // TEST 2: Invalid Login & Authentication
  console.log('\n[Test 2] Testing Authentication Credentials & Token Validation...');
  const badLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'admin@medway.com', password: 'wrongpassword' }
  });
  assert(badLogin.status === 401, 'Invalid password returns HTTP 401');

  const adminLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'admin@medway.com', password: 'admin123' }
  });
  assert(adminLogin.status === 200 && adminLogin.data.token, 'Admin login succeeds and returns valid JWT token');
  const adminToken = adminLogin.data.token;

  const driverLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'driver.vikram@medway.com', password: 'driver123' }
  });
  assert(driverLogin.status === 200 && driverLogin.data.token, 'Driver login succeeds and returns valid JWT token');
  const driverToken = driverLogin.data.token;

  // TEST 3: Token Verification & /api/auth/me
  console.log('\n[Test 3] Verifying Token Claims & Identity Profile...');
  const adminProfile = await request('/api/auth/me', {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert(adminProfile.status === 200 && adminProfile.data.user.role === 'ADMIN', 'Token verification correctly returns ADMIN profile');

  const tamperedProfile = await request('/api/auth/me', {
    headers: { Authorization: `Bearer ${adminToken}tampered` }
  });
  assert(tamperedProfile.status === 401, 'Tampered token signature is rejected with HTTP 401');

  // TEST 4: Role-Based Access Control (RBAC) Enforcement
  console.log('\n[Test 4] Testing Role-Based Access Control (RBAC)...');
  const driverToAdminDash = await request('/api/admin/dashboard-data', {
    headers: { Authorization: `Bearer ${driverToken}` }
  });
  assert(driverToAdminDash.status === 403, 'Driver token attempting to access Admin Dashboard is rejected with HTTP 403 Forbidden');

  const driverToAdminFree = await request('/api/admin/ambulances/free-all', {
    method: 'POST',
    headers: { Authorization: `Bearer ${driverToken}` }
  });
  assert(driverToAdminFree.status === 403, 'Driver token attempting to call Free-All is rejected with HTTP 403 Forbidden');

  const adminToAdminDash = await request('/api/admin/dashboard-data', {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert(adminToAdminDash.status === 200 && adminToAdminDash.data.success, 'Admin token successfully accesses Admin Dashboard');

  // TEST 5: Driver Identity Spoofing Protection
  console.log('\n[Test 5] Testing Driver Identity Protection & Telemetry Security...');
  const driverOnline = await request('/api/driver/online', {
    method: 'POST',
    headers: { Authorization: `Bearer ${driverToken}` },
    body: {
      driverId: 'USER-DRV-99-SPOOFED', // Attempted spoof
      vehicle_number: 'UP-16-AM-103',
      ambulance_type: 'ALS',
      latitude: 28.5355,
      longitude: 77.3910
    }
  });
  assert(driverOnline.status === 200, 'Authenticated driver goes online successfully');
  assert(driverOnline.data.driver.id === 'USER-DRV-03', 'Server ignores client-supplied driverId and derives identity from verified JWT');

  const locationPing = await request('/api/driver/location', {
    method: 'POST',
    headers: { Authorization: `Bearer ${driverToken}` },
    body: { latitude: 28.5360, longitude: 77.3920, speed_kmh: 45 }
  });
  assert(locationPing.status === 200 && locationPing.data.success, 'Driver successfully streams live location telemetry to /api/driver/location');

  // TEST 6: Rate Limiting & DoS Protection
  console.log('\n[Test 6] Testing Rate Limiting & DoS Mitigation on /api/sos...');
  let rateLimited = false;
  for (let i = 0; i < 35; i++) {
    const res = await request('/api/sos', {
      method: 'POST',
      body: { lat: 28.5355, lon: 77.3910, priority: 'Critical' }
    });
    if (res.status === 429) {
      rateLimited = true;
      console.log(`  Burst request #${i + 1}: Rate limited as expected (HTTP 429, Retry-After: ${res.headers['retry-after']}s)`);
      break;
    }
  }
  assert(rateLimited, 'Rate limiter activates and protects against burst request flooding with HTTP 429');

  // TEST 7: Reset Fleet with Admin Token
  console.log('\n[Test 7] Resetting fleet with authenticated Admin Token...');
  const adminReset = await request('/api/admin/ambulances/free-all', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert(adminReset.status === 200 && adminReset.data.success, 'Authenticated Admin successfully resets fleet');

  console.log('\n================================================================');
  console.log(`SECURITY VERIFICATION COMPLETE: ${passed}/${total} TESTS PASSED! ✅`);
  console.log('================================================================');
  process.exit(0);
}

runSecurityTests().catch((err) => {
  console.error('\n❌ Security test failed:', err);
  process.exit(1);
});
