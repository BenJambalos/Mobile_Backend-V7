// API + database test for REGISTERING A DEVICE THAT HAS NO RECORD YET (the normal case):
//
//   The Device ID and Device Key are printed on the device's box. The farmer picks a
//   farm's pond, names the device and types both values into the app. Registering CREATES
//   the device record in monitoring_devices with exactly those values; nothing has to exist
//   beforehand and nothing is generated.
//
// Needs the server running against a LOCAL database that has the current schema.sql loaded,
// plus a Super Admin (used to approve the two test farmers):
//
//   SUPERADMIN_EMAIL=you@example.com SUPERADMIN_PASSWORD=... node tests/new_device_registration_flow.js
//
// It also talks to the database directly (same .env as the server) to inspect rows. It uses
// the next free Device IDs (MAX + 1 ...) so it does not push the AUTO_INCREMENT counter far
// ahead, and it removes everything it creates.
const crypto = require('crypto');
const pool = require('../db');
const { provisionDevices } = require('../utils/deviceProvisioning');
const { registerDevice, AssignmentError } = require('../utils/deviceAssignment');
const { validateRegistrationInput, MAX_DEVICE_ID } = require('../utils/deviceInput');
const { describeRegistrationFailure } = require('../utils/dbErrors');

const BASE = process.env.API_BASE || 'http://localhost:4000/api';
const SA_EMAIL = process.env.SUPERADMIN_EMAIL || 'superadmin@hyquai.test';
const SA_PASSWORD = process.env.SUPERADMIN_PASSWORD || 'SuperAdmin123!';

let pass = 0, fail = 0;
const createdAccounts = [];
const createdFarmIds = [];
const createdDeviceIds = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
async function cleanup() {
  try {
    if (createdFarmIds.length) await pool.query('DELETE FROM aquaculture_farms WHERE farm_id IN (?)', [createdFarmIds]);
    if (createdDeviceIds.length) await pool.query('DELETE FROM monitoring_devices WHERE device_id IN (?)', [createdDeviceIds]);
    for (const id of createdAccounts) await pool.query('DELETE FROM accounts WHERE account_id = ?', [id]);
  } catch (e) { console.error('cleanup failed:', e.message); }
}
const allResponses = []; // every raw body, to prove no Device Key ever comes back
async function call(method, p, { token, body, headers } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(headers || {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  allResponses.push(text);
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json, text };
}
const q = async (sql, params) => (await pool.query(sql, params))[0];
const newKey = () => 'dk_' + crypto.randomBytes(16).toString('hex');
const countDevices = async () => (await q('SELECT COUNT(*) n FROM monitoring_devices'))[0].n;
const rowOf = async (id) => (await q('SELECT * FROM monitoring_devices WHERE device_id = ?', [id]))[0];

(async () => {
  const stamp = Date.now();
  let adminToken;

  async function makeFarmer(label, pondNames) {
    const email = `newreg_${label}_${stamp}@test.ph`, pw = 'Password123!';
    let r = await call('POST', '/auth/signup', { body: { firstName: label, lastName: 'Tester', email, password: pw } });
    const accId = r.body.accountId;
    createdAccounts.push(accId);
    await call('PUT', `/admin/accounts/${accId}/approve`, { token: adminToken });
    r = await call('POST', '/auth/login', { body: { email, password: pw } });
    r = await call('POST', '/farm', { token: r.body.token, body: { farmName: `ZZ_TEST_NEWREG_${label}_${stamp}` } });
    const token = r.body.token;
    const ponds = {};
    for (const n of pondNames) ponds[n] = Number((await call('POST', '/ponds', { token, body: { name: n } })).body.id);
    const farmId = (await q('SELECT farm_id FROM aquaculture_farms WHERE owner_id = ?', [accId]))[0].farm_id;
    createdFarmIds.push(farmId);
    return { accId, token, ponds, farmId };
  }

  let r = await call('POST', '/auth/login', { body: { email: SA_EMAIL, password: SA_PASSWORD } });
  adminToken = r.body.token;
  const F1 = await makeFarmer('one', ['Pond A', 'Pond B', 'Pond C']);
  const F2 = await makeFarmer('two', ['Pond X']);

  // next free Device IDs, so every device below is NEW (no record exists for it)
  let nextId = Number((await q('SELECT COALESCE(MAX(device_id), 0) + 1 AS n FROM monitoring_devices'))[0].n) + 5;
  const takeId = () => { const id = nextId++; createdDeviceIds.push(id); return id; };

  // The request the app sends. Everything can be overridden (or removed with undefined).
  const register = (farmer, dev, pondName, over) => call('POST', '/devices', {
    token: farmer.token,
    body: { deviceName: dev.name || 'Test Device', deviceId: String(dev.id), deviceKey: dev.key, farmId: farmer.farmId, pondId: farmer.ponds[pondName], ...(over || {}) },
  });

  // =============== A. a NEW device: no record exists, registration creates it ===============
  const D1 = { id: takeId(), key: newKey(), name: 'Charles Device' };
  check('(setup) no record exists for this Device ID or this Device Key', !(await rowOf(D1.id)) && (await q('SELECT 1 FROM monitoring_devices WHERE device_key = ?', [D1.key])).length === 0);
  const devicesBefore = await countDevices();

  r = await register(F1, D1, 'Pond A');
  check('register a never-seen Device ID + Device Key -> 201 (no "No HyQual device matches" error)', r.status === 201, r);
  check('reply: device id, name, farm, pond and a message', r.body.id === String(D1.id) && r.body.name === 'Charles Device' && r.body.farmId === String(F1.farmId) && r.body.pondId === String(F1.ponds['Pond A']) && r.body.pondName === 'Pond A' && /registered to Pond A/.test(r.body.message), r.body);
  check('reply does NOT contain the Device Key', !r.text.includes(D1.key) && r.body.deviceKey === undefined && r.body.device_key === undefined);
  let row = await rowOf(D1.id);
  check('database: ONE new row was inserted', (await countDevices()) === devicesBefore + 1);
  check('database: the row has the PRINTED Device ID and Device Key exactly as typed', !!row && row.device_id === D1.id && row.device_key === D1.key, row);
  check('database: it belongs to the farmer\'s farm and the selected pond', row.farm_id === F1.farmId && row.pond_id === F1.ponds['Pond A'], row);
  check('database: device_name is the typed name, status active, assigned_at stamped, installed_at is now',
    row.device_name === 'Charles Device' && row.status === 'active' && row.assigned_at !== null && Date.now() - new Date(row.installed_at).getTime() < 60000, row);
  const st = await q('SELECT connectivity_status, last_seen_at FROM device_status WHERE device_id = ?', [D1.id]);
  check('database: exactly one device_status row, OFFLINE until the ESP32 first talks to the API', st.length === 1 && st[0].connectivity_status === 'offline' && st[0].last_seen_at === null, st);
  const logs = await q("SELECT action_description FROM activity_logs WHERE account_id = ? AND action_type = 'device_registered'", [F1.accId]);
  check('activity log: the registration is recorded, without the Device Key', logs.length === 1 && logs[0].action_description.includes(`#${D1.id}`) && !logs[0].action_description.includes(D1.key), logs);

  r = await call('GET', '/devices', { token: F1.token });
  const listed = r.body.find((d) => Number(d.id) === D1.id);
  check('the device is in the farm\'s device list under the selected pond', !!listed && listed.pond === 'Pond A' && listed.name === 'Charles Device', r.body);
  check('the device list never contains a Device Key', !r.text.includes(D1.key));
  r = await call('GET', '/ponds', { token: F1.token });
  check('Pond A now has the device', r.body.find((p) => Number(p.id) === F1.ponds['Pond A']).assignedDeviceId === String(D1.id), r.body);
  r = await call('GET', '/auth/me', { token: F1.token });
  check('setup state counts the device, so onboarding can finish', r.status === 200 && r.body.setup.deviceCount === 1 && r.body.setup.setupComplete === true, r.body.setup);
  r = await call('GET', '/devices', { token: F2.token });
  check('the other farm does not see it', !r.body.some((d) => Number(d.id) === D1.id));

  // the app sends JSON numbers sometimes; farmId may be left out (the token's farm is used); name is optional
  const D2 = { id: takeId(), key: newKey() };
  r = await call('POST', '/devices', { token: F1.token, body: { deviceId: D2.id, deviceKey: `  ${D2.key}  `, pondId: F1.ponds['Pond B'] } });
  row = await rowOf(D2.id);
  check('numbers instead of strings, surrounding spaces, no farmId, no name -> 201 with the farm from the token and the default name',
    r.status === 201 && row.farm_id === F1.farmId && row.pond_id === F1.ponds['Pond B'] && row.device_key === D2.key && row.device_name === `Device ${D2.id}`, { r: r.body, row });

  // =============== B. the ESP32 keeps working with the same two values ===============
  const esp = (dev) => ({
    config: (key) => call('GET', `/devices/${dev.id}/config`, { headers: { 'x-device-key': key ?? dev.key } }),
    heartbeat: () => call('POST', '/ingest/status', { body: { deviceKey: dev.key, batteryPercentage: 88, isCharging: true, connectivityStatus: 'online', signalStrength: -61, activeSensorsCount: 4 } }),
    reading: (extra) => call('POST', '/ingest/readings', { body: { deviceKey: dev.key, temperature: 28.4, phLevel: 7.8, dissolvedOxygen: 6.1, salinity: 14, salinityUnit: 'ppt', createdAt: new Date().toISOString(), ...extra } }),
  });
  const e1 = esp(D1);
  r = await e1.config();
  check('ESP32: GET /devices/:id/config with the printed ID + key -> registered, pond = Pond A', r.status === 200 && r.body.registered === true && r.body.farm_id === F1.farmId && r.body.pond_id === F1.ponds['Pond A'], r.body);
  r = await e1.config('dk_wrong_key_wrong_key_wrong');
  check('ESP32: a wrong key is still refused (401)', r.status === 401, r);
  r = await e1.heartbeat();
  check('ESP32: status heartbeat accepted and answers with its pond', r.status === 200 && r.body.config.pond_id === F1.ponds['Pond A'], r.body);
  r = await e1.reading({ pondIdAtCapture: F1.ponds['Pond A'] });
  check('ESP32: a reading is stored (201) against Pond A', r.status === 201 && r.body.pond_id === F1.ponds['Pond A'], r);
  r = await call('GET', '/devices', { token: F1.token });
  check('after its first contact the device shows ONLINE in the app', r.body.find((d) => Number(d.id) === D1.id).status === 'online', r.body);

  // a device switched on BEFORE its farmer registered it: unknown to the API, keeps its data and retries
  const D3 = { id: takeId(), key: newKey(), name: 'Late Sensor' };
  const e3 = esp(D3);
  r = await e3.reading({ pondIdAtCapture: F1.ponds['Pond C'] });
  check('ESP32 not registered yet: reading refused with 401 (the firmware keeps it on the SD card and retries)', r.status === 401, r);
  r = await e3.config();
  check('ESP32 not registered yet: config answers 401 and nothing was created', r.status === 401 && !(await rowOf(D3.id)), r);
  r = await register(F1, D3, 'Pond C');
  check('the farmer then registers it -> 201', r.status === 201, r);
  r = await e3.config();
  check('ESP32: the SAME credentials now work, pond = Pond C', r.status === 200 && r.body.registered === true && r.body.pond_id === F1.ponds['Pond C'], r.body);
  r = await e3.reading({ pondIdAtCapture: F1.ponds['Pond C'] });
  check('ESP32: its queued reading is accepted now (201)', r.status === 201, r);

  // =============== C. duplicates ===============
  const countBeforeDup = await countDevices();
  r = await register(F1, D1, 'Pond B');
  check('same Device ID again, same farm -> 409 DEVICE_ALREADY_REGISTERED that names the farm', r.status === 409 && r.body.code === 'DEVICE_ALREADY_REGISTERED' && /already registered in your farm/.test(r.body.error), r);
  r = await register(F2, D1, 'Pond X');
  check('same Device ID, ANOTHER farm -> 409 DEVICE_ALREADY_REGISTERED "another account"', r.status === 409 && r.body.code === 'DEVICE_ALREADY_REGISTERED' && /another account/.test(r.body.error), r);
  check('...the other farm\'s answer does not reveal the owner or the device\'s key', !/one_|ZZ_TEST/.test(r.text) && !r.text.includes(D1.key));
  r = await register(F1, { id: D1.id, key: newKey() }, 'Pond B');
  check('same Device ID with a DIFFERENT key -> 409, and the stored key is not overwritten', r.status === 409 && (await rowOf(D1.id)).device_key === D1.key, r);
  r = await register(F2, { id: D1.id, key: newKey() }, 'Pond X');
  check('...also from another farm: the stored key is not overwritten and the owner does not change', r.status === 409 && (await rowOf(D1.id)).device_key === D1.key && (await rowOf(D1.id)).farm_id === F1.farmId, r);
  const D4 = { id: takeId(), key: D1.key };
  r = await register(F2, D4, 'Pond X');
  check('a NEW Device ID with a Device Key that already belongs to another device -> 409 DEVICE_KEY_IN_USE', r.status === 409 && r.body.code === 'DEVICE_KEY_IN_USE', r);
  check('...the message does not reveal which device owns the key', !r.text.includes('Charles') && !r.text.includes(D1.key), r.body);
  check('...and no record was created for the new Device ID', !(await rowOf(D4.id)));
  check('all duplicate attempts together created no devices', (await countDevices()) === countBeforeDup);
  row = await rowOf(D1.id);
  check('...and the original device is untouched (same farm, pond, name, key)', row.farm_id === F1.farmId && row.pond_id === F1.ponds['Pond A'] && row.device_name === 'Charles Device' && row.device_key === D1.key, row);

  // =============== D. invalid input: refused before the database, nothing created ===============
  const D5 = { id: takeId(), key: newKey() };
  const countBeforeBad = await countDevices();
  const bad = async (name, over, status, code) => {
    const res = await register(F1, D5, 'Pond B', over);
    check(`invalid input: ${name} -> ${status} ${code}`, res.status === status && res.body.code === code, res);
  };
  await bad('missing Device ID', { deviceId: undefined }, 400, 'DEVICE_ID_REQUIRED');
  await bad('blank Device ID', { deviceId: '   ' }, 400, 'DEVICE_ID_REQUIRED');
  await bad('Device ID with letters', { deviceId: 'abc' }, 400, 'INVALID_DEVICE_ID');
  await bad('Device ID 0 (MySQL would invent a number)', { deviceId: '0' }, 400, 'INVALID_DEVICE_ID');
  await bad('negative Device ID', { deviceId: '-5' }, 400, 'INVALID_DEVICE_ID');
  await bad('decimal Device ID', { deviceId: '1.5' }, 400, 'INVALID_DEVICE_ID');
  await bad('Device ID bigger than the database allows', { deviceId: String(MAX_DEVICE_ID + 1) }, 400, 'INVALID_DEVICE_ID');
  await bad('Device ID sent as an object', { deviceId: { a: 1 } }, 400, 'INVALID_DEVICE_ID');
  await bad('missing Device Key', { deviceKey: undefined }, 400, 'DEVICE_KEY_REQUIRED');
  await bad('too short Device Key', { deviceKey: 'dk_123' }, 400, 'INVALID_DEVICE_KEY');
  await bad('too long Device Key', { deviceKey: 'k'.repeat(65) }, 400, 'INVALID_DEVICE_KEY');
  await bad('Device Key with a space inside', { deviceKey: 'dk_1234567890 abcdef1234567890' }, 400, 'INVALID_DEVICE_KEY');
  await bad('Device Key sent as an array', { deviceKey: [D5.key] }, 400, 'INVALID_DEVICE_KEY');
  await bad('Device Key sent as a number', { deviceKey: 1234567890123456 }, 400, 'INVALID_DEVICE_KEY');
  await bad('Device Name longer than 100 characters', { deviceName: 'x'.repeat(101) }, 400, 'DEVICE_NAME_TOO_LONG');
  await bad('Device Name sent as a number', { deviceName: 42 }, 400, 'INVALID_DEVICE_NAME');
  await bad('missing pond', { pondId: undefined }, 400, 'POND_REQUIRED');
  await bad('pond that is not a number', { pondId: 'abc' }, 400, 'POND_NOT_FOUND');
  await bad('pond that does not exist', { pondId: 99999999 }, 400, 'POND_NOT_FOUND');
  await bad('a pond that belongs to ANOTHER farm', { pondId: F2.ponds['Pond X'] }, 400, 'POND_NOT_FOUND');
  await bad('a farm that is not the signed-in farmer\'s', { farmId: F2.farmId }, 403, 'FARM_MISMATCH');
  await bad('a farm that is not a number', { farmId: 'abc' }, 400, 'INVALID_FARM_ID');
  r = await call('POST', '/devices', { body: { deviceId: '1', deviceKey: D5.key, pondId: 1 } });
  check('not signed in -> 401', r.status === 401);
  r = await call('POST', '/devices', { token: F1.token, body: { name: 'Sensor 1' } });
  check('the OLD request (just a device name) creates nothing -> 400', r.status === 400 && !r.body.id, r);
  check('none of those requests created a device', (await countDevices()) === countBeforeBad && !(await rowOf(D5.id)));

  // a failure AFTER the INSERT undoes the INSERT (pond checked inside the same transaction)
  let rolled = null;
  try {
    await registerDevice({ deviceId: D5.id, deviceKey: D5.key, farmId: F1.farmId, pondId: F2.ponds['Pond X'], accountId: F1.accId, deviceName: 'Rollback' });
  } catch (e) { rolled = e; }
  check('registerDevice(): a pond that is not in the farm is rejected AND the new row is rolled back (no half-created device)',
    rolled instanceof AssignmentError && rolled.status === 404 && !(await rowOf(D5.id)) && (await q('SELECT 1 FROM device_status WHERE device_id = ?', [D5.id])).length === 0, { rolled: rolled && rolled.message });

  // =============== E. a removed device can be registered again; a stranger's key cannot take its ID ===============
  const D6 = { id: takeId(), key: newKey(), name: 'Moves Around' };
  r = await register(F1, D6, 'Pond B');
  check('(setup) D6 registered to farm one', r.status === 201, r);
  await esp(D6).reading({ pondIdAtCapture: F1.ponds['Pond B'] });
  const readingsOfD6 = (await q('SELECT COUNT(*) n FROM water_quality_readings WHERE device_id = ?', [D6.id]))[0].n;
  r = await call('DELETE', `/devices/${D6.id}`, { token: F1.token });
  row = await rowOf(D6.id);
  check('the owner removes it: the row stays, unregistered, with its Device ID and Device Key', r.status === 200 && !!row && row.farm_id === null && row.pond_id === null && row.device_key === D6.key, row);
  const countBeforeOrphan = await countDevices();
  r = await register(F2, { id: D6.id, key: newKey() }, 'Pond X');
  check('typing the Device ID with a different key does NOT take over the unregistered record -> 409 DEVICE_ID_CONFLICT', r.status === 409 && r.body.code === 'DEVICE_ID_CONFLICT' && (await rowOf(D6.id)).farm_id === null && (await rowOf(D6.id)).device_key === D6.key, r);
  r = await register(F2, { ...D6, name: 'Second Owner' }, 'Pond X');
  row = await rowOf(D6.id);
  check('the printed ID + key register it again (to another farm): 201, the SAME row is reused, not duplicated',
    r.status === 201 && (await countDevices()) === countBeforeOrphan && row.farm_id === F2.farmId && row.pond_id === F2.ponds['Pond X'] && row.device_key === D6.key && row.device_name === 'Second Owner', { r: r.body, row });
  check('its readings kept their ID and the first farm\'s pond', (await q('SELECT COUNT(*) n FROM water_quality_readings WHERE device_id = ? AND pond_id = ?', [D6.id, F1.ponds['Pond B']]))[0].n === readingsOfD6);

  // a device made earlier with scripts/provision_device.js still registers with its box values
  const [prov] = await provisionDevices(1);
  createdDeviceIds.push(prov.device_id);
  // The generator takes the next AUTO_INCREMENT number, which on a fresh database is the very ID
  // this test would hand out next. Skip past it so every later "new" ID really is new.
  nextId = Math.max(nextId, Number(prov.device_id) + 1);
  const countBeforeProv = await countDevices();
  r = await register(F1, { id: prov.device_id, key: prov.device_key, name: 'Provisioned One' }, 'Pond C');
  row = await rowOf(prov.device_id);
  check('a device made by scripts/provision_device.js registers with its printed values (record re-used, not duplicated)',
    r.status === 201 && (await countDevices()) === countBeforeProv && row.farm_id === F1.farmId && row.device_name === 'Provisioned One', { r: r.body, row });
  check('...and it displaced Pond C\'s previous device, which the reply names', !!r.body.displaced_device && r.body.displaced_device.device_id === D3.id, r.body);

  // =============== F. races: exactly one winner, one row ===============
  const R1a = { id: takeId(), key: newKey(), name: 'Race 1a' };
  let race = await Promise.all([register(F1, R1a, 'Pond A'), register(F2, { ...R1a, key: newKey(), name: 'Race 1b' }, 'Pond X')]);
  check('two farms register the SAME NEW Device ID at the same moment: one 201, one 409, no 500',
    race.filter((x) => x.status === 201).length === 1 && race.filter((x) => x.status === 409).length === 1, race.map((x) => x.status));
  check('...the database has exactly one row for that Device ID', (await q('SELECT COUNT(*) n FROM monitoring_devices WHERE device_id = ?', [R1a.id]))[0].n === 1);

  const shared = newKey();
  const R2a = { id: takeId(), key: shared }, R2b = { id: takeId(), key: shared };
  race = await Promise.all([register(F1, R2a, 'Pond B'), register(F2, R2b, 'Pond X')]);
  check('two DIFFERENT new Device IDs with the SAME Device Key at the same moment: one 201, one 409 DEVICE_KEY_IN_USE',
    race.filter((x) => x.status === 201).length === 1 && race.filter((x) => x.status === 409 && x.body.code === 'DEVICE_KEY_IN_USE').length === 1, race.map((x) => [x.status, x.body && x.body.code]));
  check('...the database has exactly one row with that key', (await q('SELECT COUNT(*) n FROM monitoring_devices WHERE device_key = ?', [shared]))[0].n === 1);

  const R3 = { id: takeId(), key: newKey(), name: 'Double Tap' };
  race = await Promise.all([register(F1, R3, 'Pond C'), register(F1, R3, 'Pond C'), register(F1, R3, 'Pond C')]);
  check('the same form submitted three times at once (double tap): one 201, the others 409, no 500',
    race.filter((x) => x.status === 201).length === 1 && race.filter((x) => x.status === 409).length === 2, race.map((x) => x.status));
  check('...exactly one row', (await q('SELECT COUNT(*) n FROM monitoring_devices WHERE device_id = ?', [R3.id]))[0].n === 1);

  const R4a = { id: takeId(), key: newKey() }, R4b = { id: takeId(), key: newKey() };
  race = await Promise.all([register(F2, R4a, 'Pond X'), register(F2, R4b, 'Pond X')]);
  check('two NEW devices registered into one pond at once: no server error', race.every((x) => x.status === 201), race.map((x) => x.status));
  check('...both exist, and the pond ends with at most ONE device', (await q('SELECT COUNT(*) n FROM monitoring_devices WHERE device_id IN (?, ?)', [R4a.id, R4b.id]))[0].n === 2
    && (await q('SELECT COUNT(*) n FROM monitoring_devices WHERE pond_id = ?', [F2.ponds['Pond X']]))[0].n === 1);

  // =============== G. an occupied pond ===============
  const D7 = { id: takeId(), key: newKey(), name: 'Newcomer' };
  const occupant = (await q('SELECT device_id FROM monitoring_devices WHERE pond_id = ?', [F1.ponds['Pond A']]))[0];
  r = await register(F1, D7, 'Pond A');
  check('registering a new device into a pond that has one: 201, the previous device is reported as displaced and stays in the farm',
    r.status === 201 && r.body.displaced_device && r.body.displaced_device.device_id === occupant.device_id && (await rowOf(occupant.device_id)).farm_id === F1.farmId && (await rowOf(occupant.device_id)).pond_id === null, r.body);

  // =============== H. database failures are explained, not hidden (pure checks, no database) ===============
  const f = (code) => describeRegistrationFailure({ code, sqlMessage: "Duplicate entry 'dk_secret' for key 'device_key'", sql: "INSERT ... 'dk_secret'" });
  check('db failure: connection refused -> 503 DATABASE_UNAVAILABLE', f('ECONNREFUSED').status === 503 && f('ECONNREFUSED').code === 'DATABASE_UNAVAILABLE');
  check('db failure: lost connection -> 503 DATABASE_UNAVAILABLE', f('PROTOCOL_CONNECTION_LOST').code === 'DATABASE_UNAVAILABLE');
  check('db failure: deadlock / lock timeout -> 503 DATABASE_BUSY', f('ER_LOCK_DEADLOCK').code === 'DATABASE_BUSY' && f('ER_LOCK_WAIT_TIMEOUT').status === 503);
  check('db failure: farm or pond vanished (foreign key) -> 409 FARM_OR_POND_MISSING', f('ER_NO_REFERENCED_ROW_2').status === 409);
  check('db failure: value too long / out of range -> 400 INVALID_DEVICE_INPUT', f('ER_DATA_TOO_LONG').status === 400 && f('ER_WARN_DATA_OUT_OF_RANGE').code === 'INVALID_DEVICE_INPUT');
  check('db failure: anything else -> 500 DATABASE_ERROR that says nothing was changed', f('ER_SOMETHING_NEW').status === 500 && f('ER_SOMETHING_NEW').code === 'DATABASE_ERROR' && /Nothing was changed/.test(f('ER_SOMETHING_NEW').error));
  check('db failure: neither the answer nor the log code ever contains the typed key or the SQL',
    ['ECONNREFUSED', 'ER_DUP_ENTRY', 'ER_X'].every((c) => !JSON.stringify(f(c)).includes('dk_secret')));
  check('validator: a complete request passes and is trimmed', (() => {
    const v = validateRegistrationInput({ deviceId: ' 12 ', deviceKey: ` ${newKey()} `, deviceName: ' N ', pondId: '3', farmId: '7' }, 7);
    return v.ok && v.deviceId === 12 && v.deviceName === 'N' && v.pondId === 3 && v.farmId === 7 && !/\s/.test(v.deviceKey);
  })());
  check('validator: a body that is not an object is refused, not a crash', validateRegistrationInput(null, 1).ok === false && validateRegistrationInput('x', 1).ok === false);

  // =============== I. keys never leave the API ===============
  const allKeys = [D1, D2, D3, D6, R1a, R2a, R3, R4a, R4b, D7, { key: prov.device_key }].map((d) => d.key).filter(Boolean);
  const leaked = allResponses.filter((t) => allKeys.some((k) => t.includes(k)));
  check('across every response of this whole test, no Device Key was ever sent back by the API', leaked.length === 0, leaked.slice(0, 2));

  await cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); await cleanup(); try { await pool.end(); } catch {} process.exit(1); });
