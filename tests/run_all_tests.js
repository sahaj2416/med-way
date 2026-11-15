const { spawnSync } = require('child_process');
const path = require('path');
const http = require('http');

const testFiles = [
  'accidental_dispatch_test.js',
  'clinical_triage_test.js',
  'reload_tracking_test.js',
  'road_safety_test.js',
  'security_test.js',
  'telemetry_architecture_test.js',
  'performance_reliability_test.js',
  'concurrency_test.js'
];

async function checkServer() {
  return new Promise((resolve) => {
    http.get('http://localhost:3000/health', (res) => {
      resolve(res.statusCode === 200);
    }).on('error', () => {
      resolve(false);
    });
  });
}

async function runAll() {
  console.log('================================================================');
  console.log('MED WAY: MASTER TEST RUNNER');
  console.log('================================================================\n');

  const serverReady = await checkServer();
  if (!serverReady) {
    console.error('❌ Error: Med Way server is not running on http://localhost:3000.');
    console.error('Please run "npm start" in another terminal before running tests.\n');
    process.exit(1);
  }

  let passedSuites = 0;
  const failedSuites = [];

  for (let i = 0; i < testFiles.length; i++) {
    const file = testFiles[i];
    const fullPath = path.join(__dirname, file);
    console.log(`\n>>> [${i + 1}/${testFiles.length}] EXECUTING: ${file} <<<`);

    const result = spawnSync(process.execPath, [fullPath], {
      stdio: 'inherit',
      env: process.env
    });

    if (result.status === 0) {
      passedSuites++;
      console.log(`✓ [${file}] PASSED SUCCESSFULLY.\n`);
    } else {
      failedSuites.push(file);
      console.error(`❌ [${file}] FAILED (exit code: ${result.status}).\n`);
    }
  }

  console.log('================================================================');
  console.log(`MASTER TEST RUN COMPLETED: ${passedSuites}/${testFiles.length} SUITES PASSED`);
  if (failedSuites.length > 0) {
    console.error(`FAILED SUITES: ${failedSuites.join(', ')}`);
    console.log('================================================================\n');
    process.exit(1);
  } else {
    console.log('ALL VERIFICATION TEST SUITES PASSED WITH 100% SUCCESS! ✅');
    console.log('================================================================\n');
  }
}

runAll().catch((err) => {
  console.error('Master test runner fatal error:', err);
  process.exit(1);
});
