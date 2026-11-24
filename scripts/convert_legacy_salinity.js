// OPTIONAL, one-time: converts salinity values that were stored BEFORE the
// salinity conversion existed.
//
// Until now the ESP32's EC reading (mS/cm) was stored in `salinity` as-is, so a
// real pond's old rows hold conductivity, not ppt (a 14.5 ppt pond is stored as
// 24). New readings are converted when they arrive (utils/salinity.js). Old rows
// are NOT changed by the update - this script is how you fix them if you want
// your charts and reports to be consistent. If you do not run it, nothing breaks:
// the history simply keeps the old scale.
//
// SAFE BY DEFAULT
//   * It only prints what it WOULD do unless you add --apply.
//   * You must name the device (--device) and a cut-off time (--before): ONLY that
//     device's readings recorded before that moment are touched. Demo/seed
//     readings (which are already ppt) and other devices are never selected.
//   * Before changing anything it copies the old values to a backup table
//     (water_quality_salinity_backup_<timestamp>), so the change can be undone.
//
// USAGE (point it at Railway with DB_URL, see scripts/_target.js)
//   node scripts/convert_legacy_salinity.js --device 6 --before 2026-11-08T00:00:00Z
//   node scripts/convert_legacy_salinity.js --device 6 --before 2026-11-08T00:00:00Z --apply
//
// Choose --before = the moment you deployed the new backend (UTC). Anything
// recorded after that is already in ppt and must not be converted twice.
// Back up the database first (Railway > MySQL > Backups) and run it on a copy
// before the real database.
const mysql = require('mysql2/promise');
const { target, describe, explain } = require('./_target');
const { toPpt } = require('../utils/salinity');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

(async () => {
  const deviceId = Number(arg('device'));
  const beforeRaw = arg('before');
  const apply = process.argv.includes('--apply');
  const before = beforeRaw ? new Date(beforeRaw) : null;
  if (!Number.isInteger(deviceId) || deviceId <= 0 || !before || Number.isNaN(before.getTime())) {
    console.error('Usage: node scripts/convert_legacy_salinity.js --device <device_id> --before <ISO time, UTC> [--apply]');
    console.error('Example: node scripts/convert_legacy_salinity.js --device 6 --before 2026-11-08T00:00:00Z');
    process.exit(1);
  }

  const t = target();
  if (!t.host || !t.user || !t.database) { console.error('No database selected. Set DB_URL first.'); process.exit(1); }
  console.log(`Connecting to ${describe(t)} ...`);

  let conn;
  try {
    conn = await mysql.createConnection({ ...t, charset: 'utf8mb4', connectTimeout: 15000, timezone: 'Z', decimalNumbers: true });
    await conn.query("SET time_zone = '+00:00'");

    const [rows] = await conn.query(
      'SELECT reading_id, salinity, recorded_at FROM water_quality_readings WHERE device_id = ? AND recorded_at < ? AND salinity IS NOT NULL ORDER BY reading_id',
      [deviceId, before]
    );
    console.log(`${rows.length} reading(s) from device ${deviceId} before ${before.toISOString()} have a salinity value.`);
    if (!rows.length) return;

    const plan = rows.map((r) => ({ id: r.reading_id, from: Number(r.salinity), to: toPpt(Number(r.salinity), 'mS/cm') }));
    const bad = plan.filter((p) => p.to.value === null);
    const good = plan.filter((p) => p.to.value !== null);
    console.log('Examples (old value as mS/cm -> ppt):');
    for (const p of good.slice(0, 5)) console.log(`  reading ${p.id}: ${p.from} -> ${p.to.value}`);
    if (bad.length) console.log(`${bad.length} value(s) are not plausible conductivity readings and would be set to NULL (e.g. reading ${bad[0].id} = ${bad[0].from}).`);

    // A history that already looks like ppt (everything under ~15) is suspicious: say so.
    const max = Math.max(...plan.map((p) => p.from));
    if (max < 8) console.log('WARNING: the largest stored value is below 8. These may already be ppt. Check before using --apply.');

    if (!apply) {
      console.log('\nDRY RUN: nothing was changed. Add --apply to convert these rows.');
      return;
    }

    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const backup = `water_quality_salinity_backup_${stamp}`;
    // DDL commits implicitly in MySQL, so the backup is made first, OUTSIDE the transaction
    // that changes the readings (a failure below then rolls back every change).
    await conn.query(`CREATE TABLE \`${backup}\` AS SELECT reading_id, salinity AS old_salinity, NOW() AS backed_up_at FROM water_quality_readings WHERE device_id = ? AND recorded_at < ? AND salinity IS NOT NULL`, [deviceId, before]);
    await conn.beginTransaction();
    let changed = 0;
    for (const p of plan) {
      const [r] = await conn.query('UPDATE water_quality_readings SET salinity = ? WHERE reading_id = ? AND salinity = ?', [p.to.value, p.id, p.from]);
      changed += r.affectedRows;
    }
    await conn.commit();
    console.log(`\nDone: ${changed} reading(s) converted. Old values are in table ${backup}.`);
    console.log(`To undo: UPDATE water_quality_readings w JOIN ${backup} b ON b.reading_id = w.reading_id SET w.salinity = b.old_salinity;`);
  } catch (err) {
    if (conn) { try { await conn.rollback(); } catch {} }
    console.error(`FAILED: ${err.code || ''} ${err.message}`);
    const hint = explain(err);
    if (hint) console.error('Hint: ' + hint);
    process.exitCode = 1;
  } finally {
    if (conn) await conn.end();
  }
})();
