const { db, initDb } = require('./database');
const { hashPassword } = require('../utils/auth');

function getRealisticBeds(name) {
  const lower = (name || '').toLowerCase();
  const isLarge = lower.includes('hospital') || lower.includes('institute') || lower.includes('medical') || lower.includes('district') || lower.includes('fortis') || lower.includes('jaypee') || lower.includes('kailash');
  const isClinic = lower.includes('clinic') || lower.includes('dispensary') || lower.includes('dental') || lower.includes('eye') || lower.includes('care centre');

  let availableBeds;
  let availableIcuBeds;

  if (isLarge) {
    availableBeds = Math.floor(Math.random() * (160 - 45 + 1)) + 45;
    const ratio = 0.12 + Math.random() * 0.10;
    availableIcuBeds = Math.max(5, Math.floor(availableBeds * ratio));
  } else if (isClinic) {
    availableBeds = Math.floor(Math.random() * (25 - 6 + 1)) + 6;
    availableIcuBeds = Math.floor(Math.random() * 4) + 1;
  } else {
    availableBeds = Math.floor(Math.random() * (60 - 15 + 1)) + 15;
    const ratio = 0.10 + Math.random() * 0.08;
    availableIcuBeds = Math.max(2, Math.floor(availableBeds * ratio));
  }

  return { availableBeds, availableIcuBeds };
}

function inferCapabilities(name) {
  const lower = (name || '').toLowerCase();
  const caps = new Set(['GENERAL']);

  if (lower.includes('cardiac') || lower.includes('heart') || lower.includes('apollo') || lower.includes('fortis') || lower.includes('jaypee') || lower.includes('super speciality') || lower.includes('multispeciality') || lower.includes('kailash')) {
    caps.add('CARDIAC');
  }
  if (lower.includes('stroke') || lower.includes('neuro') || lower.includes('brain') || lower.includes('apollo') || lower.includes('fortis') || lower.includes('super speciality') || lower.includes('multispeciality')) {
    caps.add('STROKE');
  }
  if (lower.includes('ortho') || lower.includes('trauma') || lower.includes('fracture') || lower.includes('accident') || lower.includes('district') || lower.includes('emergency') || lower.includes('super speciality') || lower.includes('multispeciality') || lower.includes('jaypee')) {
    caps.add('TRAUMA');
  }
  if (lower.includes('women') || lower.includes('matern') || lower.includes('mother') || lower.includes('child') || lower.includes('gynec') || lower.includes('district') || lower.includes('fortis') || lower.includes('super speciality') || lower.includes('yatharth')) {
    caps.add('PREGNANCY');
  }
  return Array.from(caps);
}

async function seed() {
  await initDb();

  return new Promise((resolve, reject) => {
    db.serialize(() => {
      const hospitalStmt = db.prepare(`
        INSERT INTO hospitals (
          id, name, latitude, longitude, road_node_id, type, emergency_available, available_beds, available_icu_beds
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          latitude = excluded.latitude,
          longitude = excluded.longitude,
          road_node_id = excluded.road_node_id,
          type = excluded.type,
          emergency_available = excluded.emergency_available,
          available_beds = excluded.available_beds,
          available_icu_beds = excluded.available_icu_beds
      `);

      const hospitals = [
        {
          id: 'HOSP-001',
          name: 'Jaypee Hospital',
          latitude: 28.5175,
          longitude: 77.3712,
          road_node_id: 'NODE-JP',
          type: 'Private',
          emergency_available: 1,
          capabilities: ['CARDIAC', 'TRAUMA', 'STROKE', 'GENERAL']
        },
        {
          id: 'HOSP-002',
          name: 'Fortis Hospital Noida',
          latitude: 28.6186,
          longitude: 77.3725,
          road_node_id: 'NODE-FORTIS',
          type: 'Private',
          emergency_available: 1,
          capabilities: ['CARDIAC', 'STROKE', 'PREGNANCY', 'TRAUMA', 'GENERAL']
        },
        {
          id: 'HOSP-003',
          name: 'Kailash Hospital',
          latitude: 28.5708,
          longitude: 77.3271,
          road_node_id: 'NODE-KAILASH',
          type: 'Private',
          emergency_available: 1,
          capabilities: ['TRAUMA', 'PREGNANCY', 'GENERAL']
        },
        {
          id: 'HOSP-004',
          name: 'District Combined Hospital',
          latitude: 28.5684,
          longitude: 77.3621,
          road_node_id: 'NODE-DIST',
          type: 'Government',
          emergency_available: 1,
          capabilities: ['GENERAL', 'TRAUMA', 'PREGNANCY']
        },
        {
          id: 'HOSP-005',
          name: 'ESI Hospital',
          latitude: 28.5882,
          longitude: 77.3364,
          road_node_id: 'NODE-ESI',
          type: 'Government',
          emergency_available: 1,
          capabilities: ['GENERAL', 'TRAUMA', 'PREGNANCY']
        },
        {
          id: 'HOSP-006',
          name: 'Indraprastha Apollo Hospital',
          latitude: 28.5408,
          longitude: 77.2835,
          road_node_id: 'NODE-APOLLO',
          type: 'Private',
          emergency_available: 1,
          capabilities: ['CARDIAC', 'STROKE', 'TRAUMA', 'GENERAL']
        },
        {
          id: 'HOSP-007',
          name: 'Yatharth Super Speciality Hospital',
          latitude: 28.5085,
          longitude: 77.4045,
          road_node_id: 'NODE-YATHARTH',
          type: 'Private',
          emergency_available: 1,
          capabilities: ['CARDIAC', 'TRAUMA', 'GENERAL', 'PREGNANCY']
        }
      ];

      const capabilityStmt = db.prepare(`
        INSERT OR IGNORE INTO hospital_capabilities (hospital_id, specialty)
        VALUES (?, ?)
      `);

      hospitals.forEach((h) => {
        const beds = getRealisticBeds(h.name);
        hospitalStmt.run(
          h.id,
          h.name,
          h.latitude,
          h.longitude,
          h.road_node_id,
          h.type,
          h.emergency_available,
          beds.availableBeds,
          beds.availableIcuBeds
        );

        h.capabilities.forEach((cap) => {
          capabilityStmt.run(h.id, cap);
        });
      });

      hospitalStmt.finalize();
      capabilityStmt.finalize();

      db.run(`
        UPDATE hospitals
        SET type = CASE
          WHEN name LIKE '%District%' OR name LIKE '%ESI%' OR name LIKE '%Government%' OR name LIKE '%Govt%' OR name LIKE '%Combined%' OR name LIKE '%Community Health%' OR name LIKE '%Primary Health%' OR name LIKE '%Civil%'
          THEN 'Government'
          ELSE 'Private'
        END
        WHERE type IS NULL OR type = '' OR type = 'Private'
      `);

      db.all('SELECT id, name FROM hospitals', [], (allErr, allHospitals) => {
        if (!allErr && allHospitals) {
          const updateBedsStmt = db.prepare(`
            UPDATE hospitals
            SET available_beds = ?, available_icu_beds = ?
            WHERE id = ?
          `);
          const addCapStmt = db.prepare(`
            INSERT OR IGNORE INTO hospital_capabilities (hospital_id, specialty)
            VALUES (?, ?)
          `);

          allHospitals.forEach((hosp) => {
            const b = getRealisticBeds(hosp.name);
            updateBedsStmt.run(b.availableBeds, b.availableIcuBeds, hosp.id);

            const caps = inferCapabilities(hosp.name);
            caps.forEach((cap) => {
              addCapStmt.run(hosp.id, cap);
            });
          });

          updateBedsStmt.finalize();
          addCapStmt.finalize();
        }
      });

      const ambulanceStmt = db.prepare(`
        INSERT OR IGNORE INTO ambulances (
          id, vehicle_number, ambulance_type, status, latitude, longitude, road_node_id, current_driver_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const ambulances = [
        {
          id: 'AMB-101',
          vehicle_number: 'UP-16-AM-101',
          ambulance_type: 'ALS',
          status: 'AVAILABLE',
          latitude: 28.5355,
          longitude: 77.3910,
          road_node_id: 'NODE-AMB-101',
          current_driver_id: 'USER-DRV-01'
        },
        {
          id: 'AMB-102',
          vehicle_number: 'UP-16-AM-102',
          ambulance_type: 'BLS',
          status: 'AVAILABLE',
          latitude: 28.5800,
          longitude: 77.3200,
          road_node_id: 'NODE-AMB-102',
          current_driver_id: 'USER-DRV-02'
        },
        {
          id: 'AMB-103',
          vehicle_number: 'UP-16-AM-103',
          ambulance_type: 'ALS',
          status: 'AVAILABLE',
          latitude: 28.6100,
          longitude: 77.3600,
          road_node_id: 'NODE-AMB-103',
          current_driver_id: 'USER-DRV-03'
        },
        {
          id: 'AMB-104',
          vehicle_number: 'UP-16-AM-104',
          ambulance_type: 'BLS',
          status: 'AVAILABLE',
          latitude: 28.5500,
          longitude: 77.3400,
          road_node_id: 'NODE-AMB-104',
          current_driver_id: 'USER-DRV-04'
        },
        {
          id: 'AMB-105',
          vehicle_number: 'UP-16-AM-105',
          ambulance_type: 'ICU',
          status: 'AVAILABLE',
          latitude: 28.5200,
          longitude: 77.3800,
          road_node_id: 'NODE-AMB-105',
          current_driver_id: 'USER-DRV-05'
        },
        {
          id: 'AMB-106',
          vehicle_number: 'UP-16-AM-106',
          ambulance_type: 'ALS',
          status: 'AVAILABLE',
          latitude: 28.5835,
          longitude: 77.3120,
          road_node_id: '12096500617',
          current_driver_id: 'USER-DRV-06'
        },
        {
          id: 'AMB-107',
          vehicle_number: 'UP-16-AM-107',
          ambulance_type: 'BLS',
          status: 'AVAILABLE',
          latitude: 28.5785,
          longitude: 77.3625,
          road_node_id: '9840378385',
          current_driver_id: 'USER-DRV-07'
        },
        {
          id: 'AMB-108',
          vehicle_number: 'UP-16-AM-108',
          ambulance_type: 'ICU',
          status: 'AVAILABLE',
          latitude: 28.6295,
          longitude: 77.3825,
          road_node_id: '853663626',
          current_driver_id: 'USER-DRV-08'
        },
        {
          id: 'AMB-109',
          vehicle_number: 'UP-16-AM-109',
          ambulance_type: 'ALS',
          status: 'AVAILABLE',
          latitude: 28.5732,
          longitude: 77.3872,
          road_node_id: '4215039102',
          current_driver_id: 'USER-DRV-09'
        },
        {
          id: 'AMB-110',
          vehicle_number: 'UP-16-AM-110',
          ambulance_type: 'BLS',
          status: 'AVAILABLE',
          latitude: 28.5135,
          longitude: 77.3995,
          road_node_id: '9565690574',
          current_driver_id: 'USER-DRV-10'
        },
        {
          id: 'AMB-111',
          vehicle_number: 'UP-16-AM-111',
          ambulance_type: 'ALS',
          status: 'AVAILABLE',
          latitude: 28.5025,
          longitude: 77.4085,
          road_node_id: '6656907784',
          current_driver_id: 'USER-DRV-11'
        },
        {
          id: 'AMB-112',
          vehicle_number: 'UP-16-AM-112',
          ambulance_type: 'ICU',
          status: 'AVAILABLE',
          latitude: 28.4655,
          longitude: 77.4425,
          road_node_id: '11348288596',
          current_driver_id: 'USER-DRV-12'
        },
        {
          id: 'AMB-113',
          vehicle_number: 'UP-16-AM-113',
          ambulance_type: 'BLS',
          status: 'AVAILABLE',
          latitude: 28.5645,
          longitude: 77.3345,
          road_node_id: '6880663287',
          current_driver_id: 'USER-DRV-13'
        },
        {
          id: 'AMB-114',
          vehicle_number: 'UP-16-AM-114',
          ambulance_type: 'ALS',
          status: 'AVAILABLE',
          latitude: 28.5950,
          longitude: 77.3450,
          road_node_id: '9832275285',
          current_driver_id: 'USER-DRV-14'
        },
        {
          id: 'AMB-115',
          vehicle_number: 'UP-16-AM-115',
          ambulance_type: 'ICU',
          status: 'AVAILABLE',
          latitude: 28.5455,
          longitude: 77.3085,
          road_node_id: '7139299053',
          current_driver_id: 'USER-DRV-15'
        }
      ];

      ambulances.forEach((amb) => {
        ambulanceStmt.run(
          amb.id,
          amb.vehicle_number,
          amb.ambulance_type,
          amb.status,
          amb.latitude,
          amb.longitude,
          amb.road_node_id,
          amb.current_driver_id
        );
      });

      ambulanceStmt.finalize();

      const userStmt = db.prepare(`
        INSERT INTO users (
          id, name, email, phone, password_hash, role
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          email = excluded.email,
          phone = excluded.phone,
          password_hash = excluded.password_hash,
          role = excluded.role
      `);

      const adminPasswordHash = hashPassword('admin123');
      const driverPasswordHash = hashPassword('driver123');
      const dispPasswordHash = hashPassword('dispatcher123');

      const users = [
        {
          id: 'USER-ADMIN-01',
          name: 'System Administrator',
          email: 'admin@medway.com',
          phone: '+919999999999',
          password_hash: adminPasswordHash,
          role: 'ADMIN'
        },
        {
          id: 'USER-DISP-01',
          name: 'Rajesh Sharma',
          email: 'dispatcher@medway.com',
          phone: '+919876543210',
          password_hash: dispPasswordHash,
          role: 'ADMIN'
        },
        {
          id: 'USER-DRV-01',
          name: 'Driver Amit',
          email: 'driver.amit@medway.com',
          phone: '+919876543211',
          password_hash: driverPasswordHash,
          role: 'DRIVER'
        },
        {
          id: 'USER-DRV-02',
          name: 'Driver Rahul',
          email: 'driver.rahul@medway.com',
          phone: '+919876543212',
          password_hash: driverPasswordHash,
          role: 'DRIVER'
        },
        {
          id: 'USER-DRV-03',
          name: 'Driver Vikram',
          email: 'driver.vikram@medway.com',
          phone: '+919876543203',
          password_hash: driverPasswordHash,
          role: 'DRIVER'
        },
        {
          id: 'USER-DRV-04',
          name: 'Driver Sanjay',
          email: 'driver.sanjay@medway.com',
          phone: '+919876543204',
          password_hash: driverPasswordHash,
          role: 'DRIVER'
        },
        {
          id: 'USER-DRV-05',
          name: 'Driver Manoj',
          email: 'driver.manoj@medway.com',
          phone: '+919876543205',
          password_hash: driverPasswordHash,
          role: 'DRIVER'
        },
        {
          id: 'USER-DRV-06',
          name: 'Driver Deepak',
          email: 'driver.deepak@medway.com',
          phone: '+919876543206',
          password_hash: driverPasswordHash,
          role: 'DRIVER'
        },
        {
          id: 'USER-DRV-07',
          name: 'Driver Suresh',
          email: 'driver.suresh@medway.com',
          phone: '+919876543207',
          password_hash: driverPasswordHash,
          role: 'DRIVER'
        },
        {
          id: 'USER-DRV-08',
          name: 'Driver Anil',
          email: 'driver.anil@medway.com',
          phone: '+919876543208',
          password_hash: driverPasswordHash,
          role: 'DRIVER'
        },
        {
          id: 'USER-DRV-09',
          name: 'Driver Rohit',
          email: 'driver.rohit@medway.com',
          phone: '+919876543209',
          password_hash: driverPasswordHash,
          role: 'DRIVER'
        },
        {
          id: 'USER-DRV-10',
          name: 'Driver Neeraj',
          email: 'driver.neeraj@medway.com',
          phone: '+919876543210',
          password_hash: driverPasswordHash,
          role: 'DRIVER'
        },
        {
          id: 'USER-DRV-11',
          name: 'Driver Arvind',
          email: 'driver.arvind@medway.com',
          phone: '+919876543211',
          password_hash: driverPasswordHash,
          role: 'DRIVER'
        },
        {
          id: 'USER-DRV-12',
          name: 'Driver Gaurav',
          email: 'driver.gaurav@medway.com',
          phone: '+919876543212',
          password_hash: driverPasswordHash,
          role: 'DRIVER'
        },
        {
          id: 'USER-DRV-13',
          name: 'Driver Pradeep',
          email: 'driver.pradeep@medway.com',
          phone: '+919876543213',
          password_hash: driverPasswordHash,
          role: 'DRIVER'
        },
        {
          id: 'USER-DRV-14',
          name: 'Driver Sunil',
          email: 'driver.sunil@medway.com',
          phone: '+919876543214',
          password_hash: driverPasswordHash,
          role: 'DRIVER'
        },
        {
          id: 'USER-DRV-15',
          name: 'Driver Mohit',
          email: 'driver.mohit@medway.com',
          phone: '+919876543215',
          password_hash: driverPasswordHash,
          role: 'DRIVER'
        }
      ];

      users.forEach((u) => {
        userStmt.run(u.id, u.name, u.email, u.phone, u.password_hash, u.role);
      });

      userStmt.finalize();

      const driverProfileStmt = db.prepare(`
        INSERT OR IGNORE INTO driver_profiles (
          id, user_id, license_number, on_duty, current_ambulance_id
        ) VALUES (?, ?, ?, ?, ?)
      `);

      const driverProfiles = [
        {
          id: 'DRV-PROF-01',
          user_id: 'USER-DRV-01',
          license_number: 'DL-UP16-2020-009876',
          on_duty: 1,
          current_ambulance_id: 'AMB-101'
        },
        {
          id: 'DRV-PROF-02',
          user_id: 'USER-DRV-02',
          license_number: 'DL-UP16-2021-005432',
          on_duty: 1,
          current_ambulance_id: 'AMB-102'
        },
        {
          id: 'DRV-PROF-03',
          user_id: 'USER-DRV-03',
          license_number: 'DL-UP16-2022-001003',
          on_duty: 1,
          current_ambulance_id: 'AMB-103'
        },
        {
          id: 'DRV-PROF-04',
          user_id: 'USER-DRV-04',
          license_number: 'DL-UP16-2022-001004',
          on_duty: 1,
          current_ambulance_id: 'AMB-104'
        },
        {
          id: 'DRV-PROF-05',
          user_id: 'USER-DRV-05',
          license_number: 'DL-UP16-2022-001005',
          on_duty: 1,
          current_ambulance_id: 'AMB-105'
        },
        {
          id: 'DRV-PROF-06',
          user_id: 'USER-DRV-06',
          license_number: 'DL-UP16-2023-001006',
          on_duty: 1,
          current_ambulance_id: 'AMB-106'
        },
        {
          id: 'DRV-PROF-07',
          user_id: 'USER-DRV-07',
          license_number: 'DL-UP16-2023-001007',
          on_duty: 1,
          current_ambulance_id: 'AMB-107'
        },
        {
          id: 'DRV-PROF-08',
          user_id: 'USER-DRV-08',
          license_number: 'DL-UP16-2023-001008',
          on_duty: 1,
          current_ambulance_id: 'AMB-108'
        },
        {
          id: 'DRV-PROF-09',
          user_id: 'USER-DRV-09',
          license_number: 'DL-UP16-2023-001009',
          on_duty: 1,
          current_ambulance_id: 'AMB-109'
        },
        {
          id: 'DRV-PROF-10',
          user_id: 'USER-DRV-10',
          license_number: 'DL-UP16-2023-001010',
          on_duty: 1,
          current_ambulance_id: 'AMB-110'
        },
        {
          id: 'DRV-PROF-11',
          user_id: 'USER-DRV-11',
          license_number: 'DL-UP16-2023-001011',
          on_duty: 1,
          current_ambulance_id: 'AMB-111'
        },
        {
          id: 'DRV-PROF-12',
          user_id: 'USER-DRV-12',
          license_number: 'DL-UP16-2023-001012',
          on_duty: 1,
          current_ambulance_id: 'AMB-112'
        },
        {
          id: 'DRV-PROF-13',
          user_id: 'USER-DRV-13',
          license_number: 'DL-UP16-2023-001013',
          on_duty: 1,
          current_ambulance_id: 'AMB-113'
        },
        {
          id: 'DRV-PROF-14',
          user_id: 'USER-DRV-14',
          license_number: 'DL-UP16-2023-001014',
          on_duty: 1,
          current_ambulance_id: 'AMB-114'
        },
        {
          id: 'DRV-PROF-15',
          user_id: 'USER-DRV-15',
          license_number: 'DL-UP16-2023-001015',
          on_duty: 1,
          current_ambulance_id: 'AMB-115'
        }
      ];

      driverProfiles.forEach((dp) => {
        driverProfileStmt.run(
          dp.id,
          dp.user_id,
          dp.license_number,
          dp.on_duty,
          dp.current_ambulance_id
        );
      });

      driverProfileStmt.finalize((err) => {
        if (err) {
          console.error('Error finalizing seed operations:', err);
          return reject(err);
        }
        console.log('Seed data inserted successfully.');
        resolve();
      });
    });
  });
}

if (require.main === module) {
  seed()
    .then(() => {
      console.log('Database seeded successfully.');
      db.close();
    })
    .catch((err) => {
      console.error('Failed to seed database:', err);
      process.exit(1);
    });
}

module.exports = { seed };
