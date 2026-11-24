// Device PROVISIONING: gives each physical HyQual device its permanent
// Device ID and Device Key. Run it ONCE per device, before the device is
// installed - never when a farmer registers a device in the app.
//
//   node scripts/provision_device.js create [count] [--csv labels.csv]
//       Creates `count` new devices (default 1) and prints each Device ID and
//       Device Key. Print BOTH on the device's box / label, and put them in the
//       firmware (DEVICE_ID / DEVICE_KEY at the top of the .ino). A new device
//       is "not registered": it belongs to no farm until a farmer enters its
//       Device ID and Device Key in the app.
//
//   node scripts/provision_device.js list [--registered | --unregistered]
//       Lists every device and whether a farm has registered it. Never prints keys.
//
//   node scripts/provision_device.js label <device_id> [<device_id> ...] [--csv labels.csv]
//       Prints the Device ID and Device Key of devices that ALREADY exist, to
//       print or re-print their box label (for example the devices you created
//       with the old "name a device" screen).
//
// Point it at Railway with DB_URL (Railway's MYSQL_PUBLIC_URL), see scripts/_target.js.
// IMPORTANT: provision against the SAME database the deployed backend uses.
// A device provisioned in a local database does not exist on Railway.
//
// The output contains device keys. Keep it private; do not paste it in chat or commit it.
const fs = require('fs');
const mysql = require('mysql2/promise');
const { target, describe, explain } = require('./_target');
const { provisionDevices } = require('../utils/deviceProvisioning');

function usage() {
  console.error(
    'Usage:\n' +
    '  node scripts/provision_device.js create [count] [--csv labels.csv]\n' +
    '  node scripts/provision_device.js list [--registered | --unregistered]\n' +
    '  node scripts/provision_device.js label <device_id> [<device_id> ...] [--csv labels.csv]'
  );
  process.exit(1);
}

function printCredentials(rows) {
  for (const d of rows) {
    console.log('');
    console.log(`  ${d.device_name}`);
    console.log(`    Device ID : ${d.device_id}`);
    console.log(`    Device Key: ${d.device_key}`);
  }
  console.log('');
  console.log('Print BOTH values on the device box / label. The same two values go in the firmware');
  console.log('(top of HyQual_Railway-Code_fixed.ino), one device per sketch upload:');
  for (const d of rows) {
    console.log('');
    console.log(`  // ${d.device_name}`);
    console.log(`  const char* DEVICE_ID = "${d.device_id}";`);
    console.log(`  const char* DEVICE_KEY = "${d.device_key}";`);
  }
}

function writeCsv(file, rows) {
  const lines = ['device_id,device_key,device_name', ...rows.map((d) => `${d.device_id},${d.device_key},"${String(d.device_name).replace(/"/g, '""')}"`)];
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  console.log(`\nLabel list written to ${file} (contains keys: keep it private).`);
}

(async () => {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!['create', 'list', 'label'].includes(command)) usage();

  // --csv <file> may appear anywhere after the command.
  let csvFile = null;
  const rest = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--csv') { csvFile = args[++i]; if (!csvFile) usage(); } else rest.push(args[i]);
  }

  const t = target();
  if (!t.host || !t.user || !t.database) {
    console.error('No database selected. Set DB_URL (e.g. to Railway\'s MYSQL_PUBLIC_URL) first.');
    process.exit(1);
  }
  console.log(`Connecting to ${describe(t)} ...`);

  let pool;
  try {
    pool = mysql.createPool({ ...t, charset: 'utf8mb4', connectTimeout: 15000, connectionLimit: 2 });

    if (command === 'create') {
      const count = rest[0] === undefined ? 1 : Number(rest[0]);
      if (!Number.isInteger(count) || count < 1 || count > 500) { console.error('count must be a whole number from 1 to 500.'); process.exit(1); }
      const created = await provisionDevices(count, pool);
      console.log(`Provisioned ${created.length} device(s). They are NOT registered to any farm yet.`);
      printCredentials(created);
      if (csvFile) writeCsv(csvFile, created);
    }

    if (command === 'list') {
      const filter = rest.includes('--registered') ? 'WHERE md.farm_id IS NOT NULL' : rest.includes('--unregistered') ? 'WHERE md.farm_id IS NULL' : '';
      const [rows] = await pool.query(
        `SELECT md.device_id, md.device_name, md.farm_id, f.farm_name, p.pond_name
           FROM monitoring_devices md
           LEFT JOIN aquaculture_farms f ON f.farm_id = md.farm_id
           LEFT JOIN ponds p ON p.pond_id = md.pond_id
           ${filter}
          ORDER BY md.device_id`
      );
      if (!rows.length) { console.log('No devices.'); }
      else {
        console.table(rows.map((r) => ({
          device_id: r.device_id,
          name: r.device_name,
          status: r.farm_id ? 'REGISTERED' : 'not registered',
          farm: r.farm_name || '',
          pond: r.pond_name || '',
        })));
      }
    }

    if (command === 'label') {
      const ids = rest.map(Number);
      if (!ids.length || ids.some((n) => !Number.isInteger(n) || n < 1)) usage();
      const [rows] = await pool.query(
        'SELECT device_id, device_name, device_key FROM monitoring_devices WHERE device_id IN (?) ORDER BY device_id',
        [ids]
      );
      const found = new Set(rows.map((r) => r.device_id));
      for (const id of ids) if (!found.has(id)) console.log(`Device ${id}: not found.`);
      const usable = rows.filter((r) => r.device_key);
      for (const r of rows) if (!r.device_key) console.log(`Device ${r.device_id}: has no device key (it cannot be registered or authenticate).`);
      if (usable.length) {
        printCredentials(usable);
        if (csvFile) writeCsv(csvFile, usable);
      }
    }
  } catch (err) {
    console.error(`FAILED: ${err.code || ''} ${err.message}`);
    const hint = explain(err);
    if (hint) console.error('Hint: ' + hint);
    if (err.code === 'ER_BAD_FIELD_ERROR' || err.code === 'ER_BAD_NULL_ERROR') {
      console.error('Hint: the database has not been migrated yet. Run: node scripts/run_sql.js database/migrations/006_device_provisioning.sql');
    }
    process.exitCode = 1;
  } finally {
    if (pool) await pool.end();
  }
})();
