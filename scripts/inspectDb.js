require('dotenv').config();
const { db } = require('../config/database');

async function run() {
  try {
    const [tables] = await db.query('SHOW TABLES');
    console.log('TABLES IN DB:');
    tables.forEach(t => console.log(' -', Object.values(t)[0]));

    for (const tbl of ['booking', 'booking_detail', 'payments', 'jadwal', 'bengkel', 'users', 'kendaraan', 'layanan']) {
      try {
        const [cols] = await db.query('DESCRIBE ' + tbl);
        console.log('\nCOLUMNS IN ' + tbl + ':');
        cols.forEach(c => console.log('  ', c.Field, c.Type, c.Null, c.Key, c.Default));
      } catch (err) {
        console.log('\nTABLE ' + tbl + ' NOT FOUND OR ERROR:', err.message);
      }
    }

    // Check sample rows from bengkel & jadwal
    const [bengkelRows] = await db.query('SELECT id, nama_bengkel, status FROM bengkel LIMIT 5');
    console.log('\nSAMPLE BENGKEL:', bengkelRows);

    const [jadwalRows] = await db.query('SELECT * FROM jadwal LIMIT 5');
    console.log('\nSAMPLE JADWAL:', jadwalRows);

    process.exit(0);
  } catch (err) {
    console.error('DB ERROR:', err);
    process.exit(1);
  }
}
run();
