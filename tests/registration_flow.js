// API + database test for the device REGISTRATION process, here for devices that were
// PROVISIONED beforehand with scripts/provision_device.js (a record with no farm):
//
//   physical device : permanent Device ID + Device Key (provisioned once)
//   farmer's app    : picks a pond, types the printed Device ID + Device Key
//   backend         : registers the device to the farm + pond. A matching unregistered
//                     record is re-registered; a record with another key is refused
//   ESP32           : keeps authenticating with the same permanent credentials,
//                     learns its pond from the backend, sends readings to it
//
// A device that was never provisioned (the normal case: the farmer simply types what is
// printed on the box and the backend CREATES the record) is covered by
// tests/new_device_registration_flow.js.
//
// Needs the server running against a LOCAL database that has the current
// schema.sql (or migrations up to 006) loaded, plus a Super Admin (used to
// approve the two test farmers):
//
//   SUPERADMIN_EMAIL=you@example.com SUPERADMIN_PASSWORD=... node tests/registration_flow.js
//
// It also talks to the database directly (same .env as the server) to inspect
// rows. It removes everything it creates, including its provisioned devices.
const { execFileSync } = require('child_process');
const path = require('path');
const pool = require('../db');
const { provisionDevices } = require('../utils/deviceProvisioning');
const { registerDevice, AssignmentError } = require('../utils/deviceAssignment');
const { sweepOfflineDevices } = require('../utils/deviceHealth');

const BASE = process.env.API_BASE || 'http://localhost:4000/api';
const SA_EMAIL = process.env.SUPERADMIN_EMAIL || 'superadmin@hyquai.test';
const SA_PASSWORD = process.env.SUPERADMIN_PASSWORD || 'SuperAdmin123!';

let pass = 0, fail = 0;
const createdAccounts = [];
const provisionedIds = [];
const createdFarmIds = [];
async function cleanup() {
  try {
    if (createdFarmIds.length) await pool.query('DELETE FROM aquaculture_farms WHERE farm_id IN (?)', [createdFarmIds]);
    if (provisionedIds.length) await pool.query('DELETE FROM monitoring_devices WHERE device_id IN (?)', [provisionedIds]);
    for (const id of createdAccounts) await pool.query('DELETE FROM accounts WHERE account_id = ?', [id]);
  } catch (e) { console.error('cleanup failed:', e.message); }
}
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
// Every raw response body is kept, so the end of the test can prove that no
// Device Key ever came back from the API.
const allResponses = [];
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

(async () => {
  const stamp = Date.now();
  let adminToken;

  async function makeFarmer(label, pondNames) {
    const email = `reg_${label}_${stamp}@test.ph`, pw = 'Password123!';
    let r = await call('POST', '/auth/signup', { body: { firstName: label, lastName: 'Tester', email, password: pw } });
    const accId = r.body.accountId;
    createdAccounts.push(accId);
    await call('PUT', `/admin/accounts/${accId}/approve`, { token: adminToken });
    r = await call('POST', '/auth/login', { body: { email, password: pw } });
    r = await call('POST', '/farm', { token: r.body.token, body: { farmName: `ZZ_TEST_REG_${label}_${stamp}` } });
    const token = r.body.token;
    const ponds = {};
    for (const n of pondNames) ponds[n] = Number((await call('POST', '/ponds', { token, body: { name: n } })).body.id);
    const farmId = (await q('SELECT farm_id FROM aquaculture_farms WHERE owner_id = ?', [accId]))[0].farm_id;
    createdFarmIds.push(farmId);
    return { accId, token, ponds, farmId };
  }

  // ---------- setup: super admin, two farmers with ponds, provisioned devices ----------
  let r = await call('POST', '/auth/login', { body: { email: SA_EMAIL, password: SA_PASSWORD } });
  adminToken = r.body.token;
  const F1 = await makeFarmer('one', ['Pond A', 'Pond B']);
  const F2 = await makeFarmer('two', ['Pond X']);

  // =============== A. PROVISIONING = the central record, done once ===============
  const batch = await provisionDevices(5);
  batch.forEach((d) => provisionedIds.push(d.device_id));
  const [D1, D2, D3, D4, D5] = batch;
  const rowOf = async (id) => (await q('SELECT * FROM monitoring_devices WHERE device_id = ?', [id]))[0];
  let row = await rowOf(D1.device_id);
  check('provisioning: row exists with NO farm and NO pond', row && row.farm_id === null && row.pond_id === null, row);
  check('provisioning: Device Key is "dk_" + 32 hex characters', /^dk_[0-9a-f]{32}$/.test(D1.device_key), D1.device_key);
  check('provisioning: key stored in the central record is the one handed out', row.device_key === D1.device_key);
  check('provisioning: default name is "Device <id>"', row.device_name === `Device ${D1.device_id}`, row.device_name);
  check('provisioning: every device gets its own Device ID and Device Key',
    new Set(batch.map((d) => d.device_id)).size === 5 && new Set(batch.map((d) => d.device_key)).size === 5);
  const st = await q('SELECT connectivity_status, last_seen_at FROM device_status WHERE device_id = ?', [D1.device_id]);
  check('provisioning: one device_status row, OFFLINE until the device first talks to the API', st.length === 1 && st[0].connectivity_status === 'offline' && st[0].last_seen_at === null, st);

  // the CLI used for real provisioning
  const out = execFileSync('node', [path.join(__dirname, '..', 'scripts', 'provision_device.js'), 'create', '1'], { env: process.env, encoding: 'utf8' });
  const cliId = Number((out.match(/Device ID : (\d+)/) || [])[1]);
  const cliKey = (out.match(/Device Key: (dk_[0-9a-f]{32})/) || [])[1];
  if (cliId) provisionedIds.push(cliId);
  const cliRow = cliId ? await rowOf(cliId) : null;
  check('scripts/provision_device.js create: prints a Device ID + Device Key that exist, unregistered', !!cliRow && cliRow.device_key === cliKey && cliRow.farm_id === null, { cliId, cliKey });
  check('scripts/provision_device.js create: prints the firmware lines', out.includes(`const char* DEVICE_ID = "${cliId}";`) && out.includes(`const char* DEVICE_KEY = "${cliKey}";`));

  // =============== B. a provisioned device BEFORE anyone registers it ===============
  const cfg = (dev, key) => call('GET', `/devices/${dev.device_id}/config`, { headers: { 'x-device-key': key ?? dev.device_key } });
  const heartbeat = (dev) => call('POST', '/ingest/status', { body: { deviceKey: dev.device_key, batteryPercentage: 90, isCharging: true, connectivityStatus: 'online', signalStrength: -60, activeSensorsCount: 4 } });
  const reading = (dev, extra) => call('POST', '/ingest/readings', { body: { deviceKey: dev.device_key, temperature: 28.4, phLevel: 7.8, dissolvedOxygen: 6.1, salinity: 14, salinityUnit: 'ppt', createdAt: new Date().toISOString(), ...extra } });

  r = await cfg(D1);
  check('ESP32 before registration: config answers 200 with registered=false and no pond', r.status === 200 && r.body.registered === false && r.body.pond_id === null && r.body.farm_id === null, r.body);
  r = await cfg(D1, 'dk_wrong');
  check('ESP32: wrong key -> 401 (same answer as an unknown device)', r.status === 401);
  r = await heartbeat(D1);
  check('ESP32 before registration: status heartbeat accepted', r.status === 200 && r.body.config.pond_id === null, r.body);
  r = await reading(D1, { pondIdAtCapture: F1.ponds['Pond A'] });
  check('ESP32 before registration: a reading is refused with 409 DEVICE_NOT_REGISTERED (device keeps it and retries)', r.status === 409 && r.body.code === 'DEVICE_NOT_REGISTERED', r);
  r = await reading(D1);
  check('ESP32 before registration: a reading without a pond is refused the same way', r.status === 409 && r.body.code === 'DEVICE_NOT_REGISTERED', r);
  check('nothing was stored for the unregistered device', (await q('SELECT COUNT(*) n FROM water_quality_readings WHERE device_id = ?', [D1.device_id]))[0].n === 0);
  r = await call('GET', '/devices', { token: F1.token });
  check('an unregistered device is in nobody\'s device list', !r.body.some((d) => Number(d.id) === D1.device_id), r.body);

  // =============== C. registration is verified by the backend ===============
  const register = (farmer, dev, pondName, over) => call('POST', '/devices', {
    token: farmer.token,
    body: { deviceId: String(dev.device_id), deviceKey: dev.device_key, pondId: String(farmer.ponds[pondName]), ...(over || {}) },
  });
  r = await call('POST', '/devices', { body: { deviceId: String(D1.device_id), deviceKey: D1.device_key, pondId: String(F1.ponds['Pond A']) } });
  check('registration needs a signed-in user -> 401', r.status === 401);
  r = await call('POST', '/devices', { token: F1.token, body: { deviceKey: D1.device_key, pondId: String(F1.ponds['Pond A']) } });
  check('missing Device ID -> 400 DEVICE_ID_REQUIRED', r.status === 400 && r.body.code === 'DEVICE_ID_REQUIRED', r);
  r = await call('POST', '/devices', { token: F1.token, body: { deviceId: 'abc', deviceKey: D1.device_key, pondId: String(F1.ponds['Pond A']) } });
  check('Device ID that is not a number -> 400 INVALID_DEVICE_ID', r.status === 400 && r.body.code === 'INVALID_DEVICE_ID', r);
  r = await call('POST', '/devices', { token: F1.token, body: { deviceId: String(D1.device_id), pondId: String(F1.ponds['Pond A']) } });
  check('missing Device Key -> 400 DEVICE_KEY_REQUIRED', r.status === 400 && r.body.code === 'DEVICE_KEY_REQUIRED', r);
  r = await call('POST', '/devices', { token: F1.token, body: { deviceId: String(D1.device_id), deviceKey: D1.device_key } });
  check('missing pond -> 400 POND_REQUIRED', r.status === 400 && r.body.code === 'POND_REQUIRED', r);
  r = await call('POST', '/devices', { token: F1.token, body: { name: 'Sensor 1' } });
  check('the OLD request (just a device name) no longer creates a device -> 400', r.status === 400 && !r.body.deviceKey && !r.body.id, r);
  const before = (await q('SELECT COUNT(*) n FROM monitoring_devices'))[0].n;

  r = await register(F1, D1, 'Pond A', { deviceKey: 'dk_' + '0'.repeat(32), deviceName: 'Sneaky Name' });
  check('right Device ID + a DIFFERENT key -> 409 DEVICE_ID_CONFLICT (the stored key is never overwritten)', r.status === 409 && r.body.code === 'DEVICE_ID_CONFLICT', r);
  r = await register(F1, D1, 'Pond A', { deviceId: '99999999' });
  check('a NEW Device ID with a key that belongs to another device -> 409 DEVICE_KEY_IN_USE, nothing created',
    r.status === 409 && r.body.code === 'DEVICE_KEY_IN_USE' && (await q('SELECT COUNT(*) n FROM monitoring_devices WHERE device_id = 99999999'))[0].n === 0, r);
  r = await register(F1, D1, 'Pond A', { deviceKey: D2.device_key });
  check('another device\'s key with this Device ID -> 409 DEVICE_ID_CONFLICT', r.status === 409 && r.body.code === 'DEVICE_ID_CONFLICT', r);
  r = await register(F1, D1, 'Pond A', { deviceKey: D1.device_key.toUpperCase() });
  check('the key is exact when taking over an unregistered record: wrong letter case is not accepted', r.status === 409 && r.body.code === 'DEVICE_ID_CONFLICT', r);
  r = await register(F1, D1, 'Pond A', { pondId: String(F2.ponds['Pond X']) });
  check('a pond that belongs to ANOTHER farm -> 400', r.status === 400 && r.body.code === 'POND_NOT_FOUND', r);
  r = await register(F1, D1, 'Pond A', { pondId: '99999999' });
  check('a pond that does not exist -> 400', r.status === 400, r);
  r = await register(F1, D1, 'Pond A', { deviceName: 'x'.repeat(101) });
  check('a device name over 100 characters -> 400 DEVICE_NAME_TOO_LONG', r.status === 400 && r.body.code === 'DEVICE_NAME_TOO_LONG', r);
  row = await rowOf(D1.device_id);
  check('after all those failures the device is still unregistered (nothing was claimed)', row.farm_id === null && row.pond_id === null, row);
  check('...and a failed attempt never renamed it (the name sent with a wrong key was ignored)', row.device_name === `Device ${D1.device_id}`, row.device_name);
  check('failed attempts created no devices', (await q('SELECT COUNT(*) n FROM monitoring_devices'))[0].n === before);

  // the same checks one level down: a failure AFTER the claim step must undo the claim
  let rolled = null;
  try {
    await registerDevice({ deviceId: D1.device_id, deviceKey: D1.device_key, farmId: F1.farmId, pondId: F2.ponds['Pond X'], accountId: F1.accId });
  } catch (e) { rolled = e; }
  row = await rowOf(D1.device_id);
  check('registerDevice(): a pond that is not in the farm is rejected AND the claim is rolled back',
    rolled instanceof AssignmentError && rolled.status === 404 && row.farm_id === null && row.pond_id === null, { rolled: rolled && rolled.message, row });

  // =============== D. successful registration ===============
  r = await call('POST', '/devices', {
    token: F1.token,
    body: { deviceId: `  ${D1.device_id}  `, deviceKey: `  ${D1.device_key}  `, pondId: F1.ponds['Pond A'], deviceName: '  Pond A Sensor  ' },
  });
  check('register: Device ID + Device Key + pond + name -> 201 (surrounding spaces are ignored)', r.status === 201, r);
  const regBody = r.body, regText = r.text;
  check('register: reply names the device and the pond', regBody.id === String(D1.device_id) && regBody.pondName === 'Pond A' && /registered to Pond A/.test(regBody.message), regBody);
  check('register: the device gets the name the farmer typed (trimmed), in the reply and the message', regBody.name === 'Pond A Sensor' && /^Pond A Sensor registered to Pond A\./.test(regBody.message), regBody);
  check('register: the reply does NOT contain the Device Key', !regText.includes(D1.device_key) && regBody.deviceKey === undefined && regBody.device_key === undefined, regBody);
  row = await rowOf(D1.device_id);
  check('database: device now belongs to the farmer\'s farm and the selected pond', row.farm_id === F1.farmId && row.pond_id === F1.ponds['Pond A'], row);
  check('database: assigned_at is stamped and installed_at moved to the registration time', row.assigned_at !== null && Date.now() - new Date(row.installed_at).getTime() < 60000, row);
  check('database: the Device Key was NOT regenerated (permanent)', row.device_key === D1.device_key);
  check('database: the Device ID is unchanged', row.device_id === D1.device_id);
  check('database: device_name is the typed name', row.device_name === 'Pond A Sensor', row.device_name);
  const logs = await q("SELECT action_description FROM activity_logs WHERE account_id = ? AND action_type = 'device_registered'", [F1.accId]);
  check('activity log: the registration is recorded against the farmer\'s account', logs.length === 1 && logs[0].action_description.includes(`#${D1.device_id}`), logs);
  check('activity log: contains no Device Key', !logs.some((l) => l.action_description.includes(D1.device_key)));

  r = await call('GET', '/devices', { token: F1.token });
  const listed = r.body.find((d) => Number(d.id) === D1.device_id);
  check('the device appears in the device list under the selected pond, with its name', !!listed && listed.pond === 'Pond A' && listed.name === 'Pond A Sensor', r.body);
  check('the device list never contains a Device Key', !r.text.includes(D1.device_key) && !/dk_[0-9a-f]{32}/.test(r.text));
  check('the device was heartbeating while unregistered, so it is ONLINE right after registration (status not reset)', listed && listed.status === 'online', listed);
  r = await call('GET', `/devices/${D1.device_id}`, { token: F1.token });
  check('device detail: pond shown, no key', r.status === 200 && r.body.pond === 'Pond A' && !r.text.includes(D1.device_key), r.body);
  r = await call('GET', '/ponds', { token: F1.token });
  const pa = r.body.find((p) => Number(p.id) === F1.ponds['Pond A']);
  check('Pond A now has the device', pa && pa.assignedDeviceId === String(D1.device_id), pa);
  const dev1AtF2 = (await call('GET', '/devices', { token: F2.token })).body;
  check('the other farm does not see this device', !dev1AtF2.some((d) => Number(d.id) === D1.device_id));
  r = await call('GET', '/auth/me', { token: F1.token });
  check('setup state (/auth/me) counts the registered device, so onboarding can finish', r.status === 200 && r.body.setup.deviceCount === 1 && r.body.setup.setupComplete === true, r.body);

  // ---- the ESP32 keeps using the SAME credentials and now learns its pond ----
  r = await cfg(D1);
  check('ESP32 after registration: SAME credentials -> config says registered, pond = Pond A', r.status === 200 && r.body.registered === true && r.body.pond_id === F1.ponds['Pond A'] && r.body.pond_name === 'Pond A', r.body);
  r = await reading(D1, { pondIdAtCapture: F1.ponds['Pond A'] });
  check('ESP32 sends a reading tagged with its pond -> stored (201)', r.status === 201 && r.body.pond_id === F1.ponds['Pond A'], r);
  const rd = await q('SELECT pond_id, device_id FROM water_quality_readings WHERE device_id = ?', [D1.device_id]);
  check('the reading was stored against Pond A', rd.length === 1 && rd[0].pond_id === F1.ponds['Pond A'], rd);
  r = await heartbeat(D1);
  check('ESP32 heartbeat after registration: config echoes Pond A', r.status === 200 && r.body.config.pond_id === F1.ponds['Pond A'], r.body);

  // ---- moving it to another pond needs NO change on the device ----
  r = await call('PUT', `/devices/${D1.device_id}/pond`, { token: F1.token, body: { pond_id: F1.ponds['Pond B'] } });
  check('moving the device to Pond B works (existing reassign flow)', r.status === 200 && r.body.pond_name === 'Pond B', r.body);
  r = await cfg(D1);
  check('ESP32: the very same credentials now report Pond B (no reprogramming)', r.status === 200 && r.body.pond_id === F1.ponds['Pond B'], r.body);
  r = await reading(D1, { pondIdAtCapture: F1.ponds['Pond B'], createdAt: new Date(Date.now() + 1000).toISOString() });
  check('and its readings now go to Pond B', r.status === 201 && r.body.pond_id === F1.ponds['Pond B'], r);

  // =============== E. duplicates and races ===============
  r = await register(F1, D1, 'Pond B');
  check('registering the SAME device again (same farm) -> 409 DEVICE_ALREADY_REGISTERED', r.status === 409 && r.body.code === 'DEVICE_ALREADY_REGISTERED' && /already registered in your farm/.test(r.body.error), r);
  r = await register(F1, D1, 'Pond A');
  check('registering it into a DIFFERENT pond is refused too (a device is never in two ponds)', r.status === 409, r);
  r = await register(F2, D1, 'Pond X');
  check('ANOTHER farm using the right credentials -> 409 "registered to another account"', r.status === 409 && r.body.code === 'DEVICE_ALREADY_REGISTERED' && /another account/.test(r.body.error), r);
  check('the other farm\'s attempt did not take the device away', (await rowOf(D1.device_id)).farm_id === F1.farmId);
  check('the other farm\'s answer does not reveal the owner', !/one_|reg_|ZZ_TEST/.test(r.text));

  // two farmers race for the same device: exactly one wins
  const race = await Promise.all([register(F1, D2, 'Pond A'), register(F2, D2, 'Pond X')]);
  const wins = race.filter((x) => x.status === 201), losses = race.filter((x) => x.status === 409);
  row = await rowOf(D2.device_id);
  check('two farms register the same device at the same moment: exactly one 201 and one 409', wins.length === 1 && losses.length === 1, race.map((x) => x.status));
  check('...and the database has it in exactly one farm and one pond', row.farm_id !== null && row.pond_id !== null &&
    ((row.farm_id === F1.farmId && row.pond_id === F1.ponds['Pond A']) || (row.farm_id === F2.farmId && row.pond_id === F2.ponds['Pond X'])), row);
  // one farmer submits twice into two different ponds at once
  const race2 = await Promise.all([register(F1, D3, 'Pond A'), register(F1, D3, 'Pond B')]);
  row = await rowOf(D3.device_id);
  check('one farmer submits the same device for two ponds at once: one 201, one 409, one pond',
    race2.filter((x) => x.status === 201).length === 1 && race2.filter((x) => x.status === 409).length === 1 && row.farm_id === F1.farmId && row.pond_id !== null, { s: race2.map((x) => x.status), row });
  // two different devices race into the same pond
  const race3 = await Promise.all([register(F2, D4, 'Pond X'), register(F2, D5, 'Pond X')]);
  const inPondX = await q('SELECT device_id FROM monitoring_devices WHERE pond_id = ?', [F2.ponds['Pond X']]);
  check('two devices registered into one pond at once: no server error', race3.every((x) => x.status < 500), race3.map((x) => x.status));
  check('...and the pond ends with at most ONE device (one device per pond)', inPondX.length === 1, inPondX);
  check('...both devices are registered to the farm, the loser is just unassigned',
    (await q('SELECT COUNT(*) n FROM monitoring_devices WHERE device_id IN (?, ?) AND farm_id = ?', [D4.device_id, D5.device_id, F2.farmId]))[0].n === 2);

  // =============== F. an occupied pond ===============
  // D1 sits in Pond B (moved above); registering another device into Pond B displaces it, and says so.
  const D6 = (await provisionDevices(1))[0];
  provisionedIds.push(D6.device_id);
  const occupant = (await q('SELECT device_id FROM monitoring_devices WHERE pond_id = ?', [F1.ponds['Pond B']]))[0];
  check('(setup) Pond B already has a device', !!occupant, occupant);
  r = await register(F1, D6, 'Pond B', { deviceName: 'Custom Sensor' });
  check('registering into a pond that already has a device: 201 + that device is reported as displaced',
    r.status === 201 && !!r.body.displaced_device && r.body.displaced_device.device_id === occupant.device_id, { body: r.body, occupant });
  check('...and the message tells the farmer which device was unassigned', /was unassigned from Pond B/.test(r.body.message), r.body);
  const displacedRow = await rowOf(occupant.device_id);
  check('...the displaced device stays registered to the farm, just without a pond', displacedRow.farm_id === F1.farmId && displacedRow.pond_id === null, displacedRow);
  const pondBCount = (await q('SELECT COUNT(*) n FROM monitoring_devices WHERE pond_id = ?', [F1.ponds['Pond B']]))[0].n;
  check('...Pond B still holds exactly one device', pondBCount === 1, pondBCount);

  // =============== G. removing a device keeps the permanent record ===============
  // D6 is the live one in Pond B: give it a reading, an offline alert, then remove it.
  r = await reading(D6, { pondIdAtCapture: F1.ponds['Pond B'] });
  check('(setup) D6 sends a reading for Pond B', r.status === 201, r);
  await q("UPDATE device_status SET last_seen_at = NOW() - INTERVAL 20 MINUTE, connectivity_status = 'online' WHERE device_id = ?", [D6.device_id]);
  await sweepOfflineDevices();
  const offAlert = await q("SELECT notification_id, is_resolved FROM early_warning_notifications WHERE device_id = ? AND title = 'Device Offline'", [D6.device_id]);
  check('(setup) a "Device Offline" alert exists for D6', offAlert.length === 1 && offAlert[0].is_resolved === 0, offAlert);
  const readingsBefore = (await q('SELECT COUNT(*) n FROM water_quality_readings WHERE device_id = ?', [D6.device_id]))[0].n;

  r = await call('DELETE', `/devices/${D6.device_id}`, { token: F2.token });
  check('another farm cannot remove it -> 404', r.status === 404, r);
  r = await call('DELETE', `/devices/${D6.device_id}`, { token: F1.token });
  check('the owner removes it -> 200', r.status === 200, r);
  row = await rowOf(D6.device_id);
  check('removal: the device row STILL EXISTS with no farm and no pond (back to "provisioned")', !!row && row.farm_id === null && row.pond_id === null && row.assigned_at === null, row);
  check('removal: Device ID and Device Key are unchanged (still valid for the box label)', row.device_id === D6.device_id && row.device_key === D6.device_key);
  check('removal: the custom name is gone, the default name is restored', row.device_name === `Device ${D6.device_id}`, row.device_name);
  check('removal: readings are kept', (await q('SELECT COUNT(*) n FROM water_quality_readings WHERE device_id = ?', [D6.device_id]))[0].n === readingsBefore && readingsBefore > 0);
  const al = await q("SELECT is_resolved, device_id FROM early_warning_notifications WHERE notification_id = ?", [offAlert[0].notification_id]);
  check('removal: the farm\'s old alert is kept but closed and no longer points at the device', al.length === 1 && al[0].is_resolved === 1 && al[0].device_id === null, al);
  r = await call('GET', '/devices', { token: F1.token });
  check('removal: it is gone from the farm\'s device list', !r.body.some((d) => Number(d.id) === D6.device_id));
  r = await cfg(D6);
  check('ESP32 after removal: SAME credentials still authenticate; registered=false, no pond', r.status === 200 && r.body.registered === false && r.body.pond_id === null, r.body);
  r = await reading(D6, { pondIdAtCapture: F1.ponds['Pond B'] });
  check('ESP32 after removal: a reading is refused (409 DEVICE_NOT_REGISTERED), nothing stored', r.status === 409 && r.body.code === 'DEVICE_NOT_REGISTERED', r);
  const logs2 = await q("SELECT action_description FROM activity_logs WHERE account_id = ? AND action_type = 'device_unregistered'", [F1.accId]);
  check('activity log: the removal is recorded', logs2.length === 1 && logs2[0].action_description.includes(`#${D6.device_id}`), logs2);

  // the same box label registers it again - for another farm this time
  r = await register(F2, D6, 'Pond X', { deviceName: '   ' });
  check('the SAME printed Device ID + Device Key register it again (to another farm) -> 201', r.status === 201, r);
  row = await rowOf(D6.device_id);
  check('re-registered: now belongs to the second farm and its pond, key still the same', row.farm_id === F2.farmId && row.pond_id === F2.ponds['Pond X'] && row.device_key === D6.device_key, row);
  check('re-registered with a blank name: it keeps the default name (no leftover from the first farm)', row.device_name === `Device ${D6.device_id}`, row.device_name);
  const pxReadings = (await q('SELECT COUNT(*) n FROM water_quality_readings WHERE pond_id = ?', [F2.ponds['Pond X']]))[0].n;
  check('the previous farm\'s readings stay in the previous farm\'s ponds (none in the new farm\'s pond)', pxReadings === 0, pxReadings);
  const oldFarmReadings = (await q('SELECT COUNT(*) n FROM water_quality_readings WHERE device_id = ? AND pond_id = ?', [D6.device_id, F1.ponds['Pond B']]))[0].n;
  check('...and they are still attached to the pond where they were taken', oldFarmReadings === readingsBefore, oldFarmReadings);
  r = await reading(D6, { pondIdAtCapture: F1.ponds['Pond B'] });
  check('a queued reading still tagged with the OLD farm\'s pond is refused for good (422) and never written there', r.status === 422 && r.body.code === 'POND_NOT_FOUND', r);

  // =============== H. an "old style" device (registered before this change) still works ===============
  const legacyKey = 'dk_' + require('crypto').randomBytes(16).toString('hex');
  F1.ponds['Pond C'] = Number((await call('POST', '/ponds', { token: F1.token, body: { name: 'Pond C' } })).body.id);
  const [ins] = await pool.query(
    'INSERT INTO monitoring_devices (farm_id, pond_id, device_name, status, device_key, assigned_at) VALUES (?, ?, ?, ?, ?, NOW() - INTERVAL 1 DAY)',
    [F1.farmId, F1.ponds['Pond C'], 'Legacy sensor', 'active', legacyKey]);
  const LEG = { device_id: ins.insertId, device_key: legacyKey };
  r = await call('GET', '/devices', { token: F1.token });
  check('legacy: a device registered with the old process is still in the farm\'s list', r.body.some((d) => Number(d.id) === LEG.device_id && d.name === 'Legacy sensor'));
  r = await cfg(LEG);
  check('legacy: its existing firmware credentials still work', r.status === 200 && r.body.registered === true && r.body.pond_id === F1.ponds['Pond C'], r.body);
  r = await register(F1, LEG, 'Pond B');
  check('legacy: it cannot be registered a second time', r.status === 409, r);

  // =============== I. keys never leave the API ===============
  const allKeys = [...batch, D6, { device_key: cliKey }, LEG].map((d) => d.device_key).filter(Boolean);
  const leaked = allResponses.filter((t) => allKeys.some((k) => t.includes(k)));
  check('across every response of this whole test, no Device Key was ever sent back by the API', leaked.length === 0, leaked.slice(0, 2));

  // ---------- clean up ----------
  await cleanup();

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); await cleanup(); try { await pool.end(); } catch {} process.exit(1); });
