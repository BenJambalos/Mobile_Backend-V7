const express = require('express');
const pool = require('../db');
const { formatDateLong } = require('../utils/time');
const { requireAuth, requireFarm } = require('../middleware/auth');
const { connectivitySql, lastContactSql } = require('../utils/deviceHealth');
const { assignDevice, registerDevice, unregisterDevice, describeMove, AssignmentError } = require('../utils/deviceAssignment');
const { validateRegistrationInput } = require('../utils/deviceInput');
const { describeRegistrationFailure } = require('../utils/dbErrors');

const router = express.Router();
router.use(requireAuth, requireFarm);

// Every pond change, registration and removal goes through utils/deviceAssignment.js.
// This turns its "not found" / "already registered" errors into the HTTP answer
// (with its machine-readable `code` when it has one); anything else is a real error.
function sendAssignmentError(res, err) {
  if (err instanceof AssignmentError) {
    return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
  throw err;
}

// Anything that is not a business reason (see utils/dbErrors.js): the database is down,
// busy or refused a value. Only the error CODE is logged, never the message, because
// mysql2's messages contain the typed Device Key.
function sendRegistrationFailure(res, err) {
  const f = describeRegistrationFailure(err);
  console.error(`Device registration failed (database): ${f.logCode}`);
  return res.status(f.status).json({ error: f.error, code: f.code });
}

// The sentence the app shows after a device was registered.
function registrationMessage(move) {
  const displaced = move.displaced_device ? ` ${move.displaced_device.device_name} was unassigned from ${move.pond_name}.` : '';
  return `${move.device_name} registered to ${move.pond_name}.${displaced}`;
}

// The sentence the app shows after a move.
function moveMessage(move) {
  if (!move.changed) return 'Device pond unchanged.';
  const to = move.pond_name ? `moved to ${move.pond_name}` : 'unassigned';
  const from = move.previous_pond_name ? ` ${move.previous_pond_name} is now offline.` : '';
  const displaced = move.displaced_device ? ` ${move.displaced_device.device_name} was unassigned from ${move.pond_name}.` : '';
  return `${move.device_name} ${to}.${from}${displaced}`;
}

function timeAgo(date) {
  if (!date) return 'never';
  const diffMs = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function connStatusToAppStatus(row) {
  // The app's status pill distinguishes online / offline / unassigned.
  // `connectivity_status` here is DERIVED by connectivitySql() from how
  // recently the device last contacted the API, so a powered-off ESP32
  // shows "offline" without ever having said so. A weak-signal device is
  // still talking to us, so it counts as online (the detail view exposes
  // "weak" separately).
  if (!row.pond_id) return 'unassigned';
  return row.connectivity_status !== 'offline' ? 'online' : 'offline';
}

// A pond may only be linked to a device of the SAME farm. Previously the
// pond id from the request was written as-is, so a farmer could point a
// device at another farm's pond id.
async function pondBelongsToFarm(pondId, farmId) {
  const id = Number(pondId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const [rows] = await pool.query('SELECT pond_id FROM ponds WHERE pond_id = ? AND farm_id = ?', [id, farmId]);
  return rows.length > 0;
}

// device_status has exactly one row per device (UNIQUE device_id), so it is
// joined directly. `recorded_at` below is the device's LAST CONTACT time,
// which is what the app shows as "last sync".
const DEVICE_QUERY = `
  SELECT md.device_id, md.device_name, md.status AS device_record_status, md.pond_id, md.installed_at,
    p.pond_name,
    ds.battery_percentage, ds.is_charging, ${connectivitySql('ds')} AS connectivity_status, ds.signal_strength,
    ds.active_sensors_count, ${lastContactSql('ds')} AS recorded_at
  FROM monitoring_devices md
  LEFT JOIN ponds p ON p.pond_id = md.pond_id
  LEFT JOIN device_status ds ON ds.device_id = md.device_id
  WHERE md.farm_id = ?
`;

function deviceRowToListJson(row) {
  return {
    id: String(row.device_id),
    name: row.device_name,
    pond: row.pond_name || 'Unassigned',
    status: connStatusToAppStatus(row),
    registeredDate: formatDateLong(row.installed_at),
    lastSync: timeAgo(row.recorded_at),
  };
}

// GET /api/devices
router.get('/devices', async (req, res) => {
  const [rows] = await pool.query(DEVICE_QUERY + ' ORDER BY md.device_id', [req.farmId]);
  res.json(rows.map(deviceRowToListJson));
});

// POST /api/devices  { deviceId, deviceKey, deviceName, pondId, farmId? }
//
// REGISTERS A DEVICE = CREATES ITS RECORD. The Device ID and Device Key are printed on
// the device's box (and programmed into its ESP32); the farmer picks the pond, names the
// device and types both values into the app. No record has to exist beforehand and
// nothing is generated: the printed ID and key are inserted into monitoring_devices as
// they are, for the farmer's farm and the chosen pond, in ONE transaction (see
// utils/deviceAssignment.js -> registerDevice). The ESP32 keeps authenticating with the
// same two values (POST /ingest/readings by key, GET /devices/:id/config by id + key).
//
// The farm is the signed-in account's own farm (from the token). farmId is optional:
// when the app sends it, it must be that same farm. deviceName is optional for the API
// (without it the device is called "Device <id>"). The Device Key is never sent back.
//
//   201 { id, name, farmId, pondId, pondName, message, displaced_device? }   created
//   400 missing / malformed input, or a pond that is not in the caller's farm
//   403 FARM_MISMATCH               farmId is not the caller's farm
//   409 DEVICE_ALREADY_REGISTERED   this Device ID is already registered (this farm or another)
//   409 DEVICE_ID_CONFLICT          the Device ID exists, unregistered, with a different key
//   409 DEVICE_KEY_IN_USE           this Device Key belongs to another device
//   503 DATABASE_BUSY / DATABASE_UNAVAILABLE, 500 DATABASE_ERROR   nothing was saved
router.post('/devices', async (req, res) => {
  const input = validateRegistrationInput(req.body, req.farmId);
  if (!input.ok) {
    return res.status(input.status).json({ error: input.error, code: input.code });
  }

  try {
    if (!(await pondBelongsToFarm(input.pondId, input.farmId))) {
      return res.status(400).json({ error: 'Pond does not exist in your farm', code: 'POND_NOT_FOUND' });
    }
    const move = await registerDevice({
      deviceId: input.deviceId,
      deviceKey: input.deviceKey,
      farmId: input.farmId,
      pondId: input.pondId,
      accountId: req.accountId,
      deviceName: input.deviceName || null,
    });
    res.status(201).json({
      id: String(move.device_id),
      name: move.device_name,
      farmId: String(input.farmId),
      pondId: String(move.pond_id),
      pondName: move.pond_name,
      message: registrationMessage(move),
      ...(move.displaced_device ? { displaced_device: move.displaced_device } : {}),
    });
  } catch (err) {
    if (err instanceof AssignmentError) return sendAssignmentError(res, err);
    sendRegistrationFailure(res, err);
  }
});

// PUT /api/devices/:id  { name?, pondId? }
// pondId omitted = leave the assignment alone (so a rename can't silently
// unassign the device); pondId null = unassign; pondId <id> = reassign.
router.put('/devices/:id', async (req, res) => {
  const { name, pondId } = req.body;
  if (pondId !== undefined && pondId !== null && !(await pondBelongsToFarm(pondId, req.farmId))) {
    return res.status(400).json({ error: 'Pond does not exist in your farm' });
  }
  const [result] = await pool.query(
    'UPDATE monitoring_devices SET device_name = COALESCE(?, device_name) WHERE device_id = ? AND farm_id = ?',
    [name ?? null, req.params.id, req.farmId]
  );
  if (!result.affectedRows) return res.status(404).json({ error: 'Device not found' });

  if (pondId === undefined) return res.json({ message: 'Device updated.' });
  try {
    const move = await assignDevice({ deviceId: req.params.id, farmId: req.farmId, pondId });
    res.json({ message: 'Device updated.', ...(await describeMove(req.farmId, move)) });
  } catch (err) {
    sendAssignmentError(res, err);
  }
});

// DELETE /api/devices/:id
// Removes the device from THIS farm. The device itself is permanent: its Device
// ID, Device Key, readings and status are kept, and it goes back to "not
// registered" so it can be registered again (by this farm or another) with the
// credentials printed on its box.
router.delete('/devices/:id', async (req, res) => {
  try {
    await unregisterDevice({ deviceId: req.params.id, farmId: req.farmId, accountId: req.accountId });
    res.json({ message: 'Device removed from your farm. You can register it again with its Device ID and Device Key.' });
  } catch (err) {
    sendAssignmentError(res, err);
  }
});

// POST /api/devices/:id/assign  { pondId }
router.post('/devices/:id/assign', async (req, res) => {
  const { pondId } = req.body;
  if (!pondId) return res.status(400).json({ error: 'pondId is required' });
  if (!(await pondBelongsToFarm(pondId, req.farmId))) {
    return res.status(400).json({ error: 'Pond does not exist in your farm' });
  }
  try {
    const move = await assignDevice({ deviceId: req.params.id, farmId: req.farmId, pondId });
    res.json({ ...(await describeMove(req.farmId, move)), message: 'Device assigned.' });
  } catch (err) {
    sendAssignmentError(res, err);
  }
});

// PUT /api/devices/:id/pond  { pond_id }
// Remote reassignment from the app. Takes effect in the database at once: the
// pond the device LEFT is OFFLINE and the pond it ENTERED is online in the very
// next GET /ponds. The ESP32 learns about it on its next config poll (every
// 10 s) and then sends a reading for the new pond straight away.
router.put('/devices/:id/pond', async (req, res) => {
  const pondId = req.body.pond_id ?? req.body.pondId;
  if (pondId === undefined || pondId === null || pondId === '') {
    return res.status(400).json({ error: 'pond_id is required' });
  }
  try {
    const move = await assignDevice({ deviceId: req.params.id, farmId: req.farmId, pondId });
    res.json({ ...(await describeMove(req.farmId, move)), message: moveMessage(move) });
  } catch (err) {
    sendAssignmentError(res, err);
  }
});

// GET /api/devices/:id  — full detail for Device Status screen
router.get('/devices/:id', async (req, res) => {
  const [rows] = await pool.query(DEVICE_QUERY + ' AND md.device_id = ?', [req.farmId, req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Device not found' });
  const row = rows[0];
  const online = row.connectivity_status !== 'offline';

  res.json({
    id: String(row.device_id),
    name: row.device_name,
    pond: row.pond_name || null,
    online,
    connectivityStatus: row.connectivity_status || 'offline',
    batteryPercent: row.battery_percentage !== null && row.battery_percentage !== undefined ? Number(row.battery_percentage) : 0,
    solarCharging: online && !!row.is_charging,
    wifiStable: row.connectivity_status === 'online',
    // An offline device is not running any sensors, whatever it last reported.
    activeSensors: online ? (row.active_sensors_count ?? 0) : 0,
    totalSensors: 4,
    lastSync: timeAgo(row.recorded_at),
  });
});

module.exports = router;
