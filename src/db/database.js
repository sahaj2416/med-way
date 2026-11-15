const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

function findDataFile(filename) {
  const candidates = [
    path.resolve(__dirname, '../../data', filename),
    path.resolve(process.cwd(), 'data', filename),
    path.resolve(__dirname, '../data', filename),
    path.resolve(process.cwd(), filename)
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

let dbPath = findDataFile('medway.db');

// In serverless environments like Vercel, the filesystem outside /tmp is read-only.
if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
  const tmpDbPath = path.join('/tmp', 'medway.db');
  if (!fs.existsSync(tmpDbPath) && fs.existsSync(dbPath)) {
    try {
      fs.copyFileSync(dbPath, tmpDbPath);
    } catch (e) {
      console.warn('Failed to copy initial DB to /tmp:', e.message);
    }
  }
  dbPath = tmpDbPath;
} else if (!fs.existsSync(path.dirname(dbPath))) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

const db = new sqlite3.Database(dbPath);

let initDbPromise = null;

function initDb() {
  if (initDbPromise) return initDbPromise;
  initDbPromise = new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('PRAGMA foreign_keys = ON;');
      db.run('PRAGMA journal_mode = WAL;');
      db.run('PRAGMA busy_timeout = 5000;');
      db.run('PRAGMA synchronous = NORMAL;');
      db.run('PRAGMA cache_size = -64000;');
      db.run('PRAGMA temp_store = MEMORY;');
      db.run('PRAGMA mmap_size = 268435456;');

      const schema = `
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT UNIQUE NOT NULL,
          phone TEXT,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS ambulances (
          id TEXT PRIMARY KEY,
          vehicle_number TEXT NOT NULL,
          ambulance_type TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'AVAILABLE',
          latitude REAL NOT NULL,
          longitude REAL NOT NULL,
          road_node_id TEXT,
          current_driver_id TEXT,
          last_location_updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS driver_profiles (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL UNIQUE,
          license_number TEXT NOT NULL,
          on_duty INTEGER DEFAULT 1,
          current_ambulance_id TEXT,
          FOREIGN KEY (user_id) REFERENCES users(id),
          FOREIGN KEY (current_ambulance_id) REFERENCES ambulances(id)
        );

        CREATE TABLE IF NOT EXISTS hospitals (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          latitude REAL NOT NULL,
          longitude REAL NOT NULL,
          road_node_id TEXT,
          type TEXT DEFAULT 'Private',
          emergency_available INTEGER,
          available_beds INTEGER,
          available_icu_beds INTEGER
        );

        CREATE TABLE IF NOT EXISTS hospital_capabilities (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hospital_id TEXT NOT NULL,
          specialty TEXT NOT NULL,
          UNIQUE(hospital_id, specialty),
          FOREIGN KEY (hospital_id) REFERENCES hospitals(id)
        );

        CREATE TABLE IF NOT EXISTS incidents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          patient_id TEXT,
          caller_session_id TEXT,
          request_type TEXT NOT NULL,
          latitude REAL NOT NULL,
          longitude REAL NOT NULL,
          road_node_id TEXT,
          address TEXT,
          landmark TEXT,
          emergency_type TEXT NOT NULL,
          priority TEXT NOT NULL,
          patient_count INTEGER DEFAULT 1,
          medical_notes TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (patient_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS dispatches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          incident_id INTEGER NOT NULL,
          ambulance_id TEXT NOT NULL,
          hospital_id TEXT NOT NULL,
          driver_id TEXT,
          status TEXT NOT NULL DEFAULT 'ASSIGNED',
          route_distance_km REAL,
          estimated_eta_minutes REAL,
          actual_duration_minutes REAL,
          route_geometry_json TEXT,
          assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          accepted_at DATETIME,
          reached_patient_at DATETIME,
          started_hospital_trip_at DATETIME,
          completed_at DATETIME,
          FOREIGN KEY (incident_id) REFERENCES incidents(id),
          FOREIGN KEY (ambulance_id) REFERENCES ambulances(id),
          FOREIGN KEY (hospital_id) REFERENCES hospitals(id),
          FOREIGN KEY (driver_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS ambulance_location_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ambulance_id TEXT NOT NULL,
          dispatch_id INTEGER,
          latitude REAL NOT NULL,
          longitude REAL NOT NULL,
          speed_kmh REAL,
          recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (ambulance_id) REFERENCES ambulances(id),
          FOREIGN KEY (dispatch_id) REFERENCES dispatches(id)
        );

        CREATE TABLE IF NOT EXISTS notifications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          title TEXT NOT NULL,
          message TEXT NOT NULL,
          type TEXT DEFAULT 'INFO',
          is_read INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id)
        );

        -- Performance & Reliability B-Tree Indices
        CREATE INDEX IF NOT EXISTS idx_ambulances_status ON ambulances(status);
        CREATE INDEX IF NOT EXISTS idx_dispatches_ambulance ON dispatches(ambulance_id, status);
        CREATE INDEX IF NOT EXISTS idx_dispatches_driver ON dispatches(driver_id, status);
        CREATE INDEX IF NOT EXISTS idx_dispatches_incident ON dispatches(incident_id);
        CREATE INDEX IF NOT EXISTS idx_amb_history_amb_time ON ambulance_location_history(ambulance_id, recorded_at DESC);
        CREATE INDEX IF NOT EXISTS idx_amb_history_dispatch ON ambulance_location_history(dispatch_id);
        CREATE INDEX IF NOT EXISTS idx_notifications_user_time ON notifications(user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_driver_profiles_amb ON driver_profiles(current_ambulance_id);
        CREATE INDEX IF NOT EXISTS idx_driver_profiles_user ON driver_profiles(user_id);
        CREATE INDEX IF NOT EXISTS idx_hosp_caps_hosp ON hospital_capabilities(hospital_id, specialty);
        CREATE INDEX IF NOT EXISTS idx_incidents_patient ON incidents(patient_id);
        CREATE INDEX IF NOT EXISTS idx_incidents_caller_session ON incidents(caller_session_id);
      `;

      db.exec(schema, (err) => {
        if (err) {
          console.error('Error creating schema tables:', err);
          return reject(err);
        }

        // Safe progressive migration: Ensure caller_session_id exists on legacy DB files
        db.all("PRAGMA table_info(incidents)", (tableErr, columns) => {
          if (!tableErr && columns && !columns.some((c) => c.name === 'caller_session_id')) {
            db.run("ALTER TABLE incidents ADD COLUMN caller_session_id TEXT", () => {
              resolve(db);
            });
          } else {
            resolve(db);
          }
        });
      });
    });
  });
  return initDbPromise;
}

initDb().catch((err) => {
  console.error('Database initialization failed:', err);
});

function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

function transactionAsync(fn) {
  return new Promise(async (resolve, reject) => {
    try {
      await runAsync('BEGIN IMMEDIATE;');
      const result = await fn();
      await runAsync('COMMIT;');
      resolve(result);
    } catch (err) {
      try {
        await runAsync('ROLLBACK;');
      } catch (rollbackErr) {
        console.error('Error during rollback:', rollbackErr);
      }
      reject(err);
    }
  });
}

function closeDb() {
  return new Promise((resolve, reject) => {
    db.run('PRAGMA wal_checkpoint(TRUNCATE);', (chkErr) => {
      if (chkErr) {
        console.error('WAL checkpoint error during database closure:', chkErr);
      }
      db.close((err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  });
}

module.exports = {
  db,
  initDb,
  runAsync,
  getAsync,
  allAsync,
  transactionAsync,
  closeDb
};
