// Salinity unit tests: the ESP32 sends the EC probe's reading in mS/cm, the rest
// of the system means ppt. This checks the conversion (pure maths) and then the
// whole path: POST /api/ingest/readings -> MySQL -> GET /api/ponds -> alert text.
//
//   node tests/salinity_flow.js        (needs the server running against a LOCAL database)
//
// Part 1 needs no server. Part 2 creates a throw-away farm named ZZ_TEST_SAL_*
// and deletes it afterwards.
const crypto = require('crypto');
const pool = require('../db');
const { signToken } = require('../middleware/auth');
const { practicalSalinity, toPpt, normaliseUnit } = require('../utils/salinity');

const BASE = process.env.API_BASE || 'http://localhost:4000/api';
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ''); }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
async function call(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}

(async () => {
  // ================================================== Part 1: the maths (no server)
  // PSS-78 is DEFINED so that standard seawater (S = 35) has C = 42.914 mS/cm at 15 C.
  check('S1 the scale\'s definition point: 42.914 mS/cm at 15 C is exactly 35 ppt', near(practicalSalinity(42.914, 15), 35, 0.0005), practicalSalinity(42.914, 15));
  check('S2 seawater (about 53 mS/cm at 25 C) is about 35 ppt', near(practicalSalinity(53.09), 35, 0.1), practicalSalinity(53.09));
  check('S3 zero conductivity is 0 ppt and never negative', practicalSalinity(0) === 0 && practicalSalinity(-3) === 0);
  check('S4 freshwater-range values behave (0.5 mS/cm is a fraction of a ppt)', practicalSalinity(0.5) > 0 && practicalSalinity(0.5) < 0.5, practicalSalinity(0.5));
  let mono = true, last = -1;
  for (let ec = 0; ec <= 80; ec += 0.5) { const s = practicalSalinity(ec); if (s < last) mono = false; last = s; }
  check('S5 more conductivity never gives less salinity (0..80 mS/cm)', mono);
  const brackish = practicalSalinity(24); // a healthy shrimp-pond reading
  check('S6 a typical brackish pond: 24 mS/cm is roughly 14-15 ppt, close to the 0.64 rule of thumb', near(brackish, 14.5, 0.3) && near(brackish, 24 * 0.64, 1.2), brackish);
  check('S7 not a number -> NaN, not 0 (a missing value must not look like fresh water)', Number.isNaN(practicalSalinity(NaN)) && Number.isNaN(practicalSalinity(undefined)));

  check('U1 unit text is normalised (mS/cm, MS/CM, "ms/cm ", uS/cm, micro sign, ppt, PSU)',
    normaliseUnit('mS/cm') === 'ms/cm' && normaliseUnit(' MS/CM ') === 'ms/cm' && normaliseUnit('\u00b5S/cm') === 'us/cm' && normaliseUnit('uS/cm') === 'us/cm' &&
    normaliseUnit('ppt') === 'ppt' && normaliseUnit('PSU') === 'psu');
  check('U2 an unknown unit is undefined (never guessed), a missing one is null', normaliseUnit('bananas') === undefined && normaliseUnit(null) === null && normaliseUnit('') === null);

  const dflt = toPpt(24);
  check('C1 no unit given = the shipped firmware = mS/cm -> converted', dflt.converted && dflt.value === Math.round(brackish * 100) / 100, dflt);
  check('C2 explicit mS/cm is converted the same way', toPpt(24, 'mS/cm').value === dflt.value);
  check('C3 explicit ppt is stored unchanged (no double conversion)', toPpt(24, 'ppt').value === 24 && toPpt(24, 'ppt').converted === null);
  check('C4 \u00b5S/cm is divided by 1000 first', toPpt(24000, 'uS/cm').value === dflt.value);
  check('C5 an unknown unit makes the value ignored (null), not guessed', (() => { const r = toPpt(24, 'bananas'); return r.value === null && r.ignored === true; })());
  check('C6 a missing value is null and NOT "ignored"', (() => { const r = toPpt(null); return r.value === null && r.ignored === false; })());
  check('C7 impossible raw values are ignored: 150 mS/cm, -1, text', toPpt(150).ignored && toPpt(-1).ignored && toPpt('abc').ignored);
  check('C8 150 ppt is impossible too', toPpt(150, 'ppt').ignored === true);
  check('C9 numbers sent as text still work ("24")', toPpt('24').value === dflt.value);
  process.env.SALINITY_DEFAULT_UNIT = 'ppt';
  check('C10 SALINITY_DEFAULT_UNIT=ppt makes a unit-less value mean ppt', toPpt(24).value === 24 && toPpt(24).converted === null);
  delete process.env.SALINITY_DEFAULT_UNIT;
  check('C11 ...and removing it restores mS/cm', toPpt(24).converted !== null);

  // ================================================== Part 2: the whole path
  const [[owner]] = await pool.query('SELECT account_id FROM accounts ORDER BY account_id LIMIT 1');
  await pool.query("DELETE FROM aquaculture_farms WHERE farm_name LIKE 'ZZ_TEST_SAL_%'");
  const [f] = await pool.query('INSERT INTO aquaculture_farms (owner_id, farm_name) VALUES (?, ?)', [owner.account_id, `ZZ_TEST_SAL_${crypto.randomBytes(3).toString('hex')}`]);
  const farmId = f.insertId;
  const [p] = await pool.query('INSERT INTO ponds (farm_id, pond_name) VALUES (?, ?)', [farmId, 'Salinity pond']);
  const pondId = p.insertId;
  const key = crypto.randomBytes(16).toString('hex');
  const [d] = await pool.query('INSERT INTO monitoring_devices (farm_id, pond_id, device_name, device_key, assigned_at) VALUES (?, ?, ?, ?, NOW() - INTERVAL 3 DAY)', [farmId, pondId, 'Salinity device', key]);
  for (const [param, lo, hi] of [['temperature', 25, 30], ['ph', 6.5, 8.5], ['dissolved_oxygen', 5, 12], ['salinity', 10, 25]]) {
    await pool.query('INSERT INTO parameter_thresholds (farm_id, parameter, min_value, max_value) VALUES (?, ?, ?, ?)', [farmId, param, lo, hi]);
  }
  const token = signToken({ accountId: owner.account_id, farmId });
  const send = (extra) => call('POST', '/ingest/readings', { body: { deviceKey: key, createdAt: new Date().toISOString(), temperature: 28, phLevel: 8, dissolvedOxygen: 6.5, ...extra } });
  const lastSalinity = async () => { const [r] = await pool.query('SELECT salinity FROM water_quality_readings WHERE pond_id = ? ORDER BY reading_id DESC LIMIT 1', [pondId]); return r[0] ? r[0].salinity : undefined; };
  const alerts = async () => { const r = await call('GET', '/notifications', { token }); return (Array.isArray(r.body) ? r.body : []).filter((n) => n.parameter === 'salinity'); };

  try {
    // exactly what the current ESP32 sends: a number, no unit
    let r = await send({ salinity: 24 });
    check('A1 a unit-less ESP32 reading is accepted', r.status === 201, r);
    check('A2 it is STORED in ppt (14.54), not as 24', (await lastSalinity()) === 14.54, await lastSalinity());
    check('A3 the response says what was converted', r.body.salinityConversion && r.body.salinityConversion.from === 24 && r.body.salinityConversion.fromUnit === 'mS/cm' && r.body.salinityConversion.to === 14.54, r.body);
    check('A4 24 mS/cm (14.5 ppt) is inside the 10-25 ppt safe range: no salinity alert', (await alerts()).length === 0, await alerts());

    // the same value read as ppt would have been 24 ppt, i.e. almost the limit; make sure we really converted
    const pond = (await call('GET', `/ponds/${pondId}`, { token })).body;
    const sal = pond && Array.isArray(pond.parameters) ? pond.parameters.find((x) => x.key === 'salinity') : null;
    check('A5 the pond detail API reports salinity in ppt (14.54, status normal)', sal && sal.value === 14.54 && sal.unit === 'ppt' && sal.status === 'normal', sal);

    r = await send({ salinity: 18, salinityUnit: 'ppt', createdAt: new Date(Date.now() + 1000).toISOString() });
    check('A6 a device that already sends ppt and says so is NOT converted again', r.status === 201 && (await lastSalinity()) === 18 && !r.body.salinityConversion, r.body);

    r = await send({ salinity: 24000, salinityUnit: 'uS/cm', createdAt: new Date(Date.now() + 2000).toISOString() });
    check('A7 \u00b5S/cm works', r.status === 201 && (await lastSalinity()) === 14.54, await lastSalinity());

    r = await send({ salinity: 24, salinityUnit: 'furlongs', createdAt: new Date(Date.now() + 3000).toISOString() });
    check('A8 an unknown unit: reading stored, salinity ignored (NULL) and reported', r.status === 201 && r.body.ignored.includes('salinity') && (await lastSalinity()) === null, r.body);

    r = await send({ salinity: 400, createdAt: new Date(Date.now() + 4000).toISOString() });
    check('A9 a disconnected/faulty probe (400 mS/cm) is ignored, never stored as a salinity', r.status === 201 && r.body.ignored.includes('salinity') && (await lastSalinity()) === null, r.body);

    // the real behaviour that matters: a too-salty pond is detected on the PPT scale
    r = await send({ salinity: 40, createdAt: new Date(Date.now() + 5000).toISOString() }); // 40 mS/cm = 25.5 ppt
    const high = await alerts();
    check('A10 40 mS/cm (25.5 ppt) is above the 25 ppt limit: a High Salinity alert is raised', (await lastSalinity()) === 25.52 && high.length === 1 && /ppt/.test(high[0].description || high[0].message || ''), { stored: await lastSalinity(), high });
    check('A11 the alert text quotes the value in ppt, not in mS/cm', high.length === 1 && /25\.52 ppt/.test(high[0].description || ''), high);

    r = await send({ phLevel: 8, salinity: null, createdAt: new Date(Date.now() + 6000).toISOString() });
    check('A12 a reading with no salinity at all is stored as NULL, not 0', r.status === 201 && (await lastSalinity()) === null);
  } finally {
    await pool.query("DELETE FROM aquaculture_farms WHERE farm_name LIKE 'ZZ_TEST_SAL_%'");
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await pool.query("DELETE FROM aquaculture_farms WHERE farm_name LIKE 'ZZ_TEST_SAL_%'"); } catch {} process.exit(1); });
