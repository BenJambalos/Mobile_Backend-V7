// The ONE place that moves a device between ponds. Every endpoint that can
// change monitoring_devices.pond_id (PUT /devices/:id, POST /devices/:id/assign,
// PUT /devices/:id/pond, POST /devices) goes through this file, so they all
// behave the same way:
//
//   * runs in a transaction, so a half-finished move can never be left behind;
//   * a pond holds AT MOST ONE device. If the target pond already has a device
//     it is unassigned (and reported as `displaced_device`) instead of leaving
//     two devices in one pond;
//   * stamps assigned_at, so the API knows which readings belong to the new
//     assignment;
//   * the pond the device LEFT has no device any more, so it is OFFLINE in the
//     very next API answer, and the pond it ENTERED is online straight away
//     (see utils/pondState.js).
//
// Registering a device (registerDevice) and removing one from a farm
// (unregisterDevice) live here too because they also change the pond
// assignment, and they reuse exactly the same move step:
//
//   registerDevice    the farmer typed the Device ID + Device Key printed on the
//                     box, named the device and chose a pond. In ONE transaction
//                     the device record is CREATED (INSERT into monitoring_devices)
//                     for the farmer's farm with exactly those printed values, and
//                     put in the pond. No record has to exist beforehand and nothing
//                     is generated. A Device ID that is already registered, or a
//                     Device Key that already belongs to another device, is refused
//                     with an explanation. The only existing row it will take over
//                     is an UNREGISTERED one (farm_id NULL, e.g. a device a farmer
//                     removed earlier) whose key matches: then it is re-registered
//                     instead of inserted, so its readings and history stay with it.
//   unregisterDevice  takes the device out of the farm and out of its pond. The
//                     row, its permanent credentials, its readings and its status
//                     are kept, so the same device can be registered again.
const pool = require('../db');
const { pondSnapshot } = require('./pondState');
const { OFFLINE_TITLE } = require('./deviceHealth');
const { keysMatch, defaultDeviceName } = require('./deviceProvisioning');

class AssignmentError extends Error {
  // `code` is an optional machine-readable reason the app can act on.
  constructor(status, message, code) {
    super(message);
    this.status = status;
    if (code) this.code = code;
  }
}

// Runs fn(conn) in one transaction: commits when it returns, rolls back when it throws.
//
// lockName (optional): a database-wide named lock (GET_LOCK) is taken BEFORE the transaction
// starts and released after it ends, on the SAME connection, so only one caller at a time
// runs fn. Used by registration (see REGISTRATION_LOCK): it is a rare action, and without
// it two people inserting the same new Device ID at the same moment deadlock on InnoDB's
// gap locks instead of simply being told "already registered". Being a lock of the database
// server (not of this Node process) it also works when Railway runs more than one instance,
// and the server drops it by itself if the connection dies.
const LOCK_WAIT_SECONDS = 10;
async function inTransaction(fn, lockName) {
  const conn = await pool.getConnection();
  let locked = false;
  let broken = false;
  try {
    if (lockName) {
      const [rows] = await conn.query('SELECT GET_LOCK(?, ?) AS got', [lockName, LOCK_WAIT_SECONDS]);
      if (!rows[0] || Number(rows[0].got) !== 1) {
        const timeout = new Error('Could not get the registration lock in time');
        timeout.code = 'ER_LOCK_WAIT_TIMEOUT'; // answered as "database busy, try again"
        throw timeout;
      }
      locked = true;
    }
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* connection already gone */ }
    throw err;
  } finally {
    if (locked) {
      try { await conn.query('SELECT RELEASE_LOCK(?)', [lockName]); } catch (_) { broken = true; }
    }
    // A connection that may still hold the lock is closed, never handed back to the pool.
    if (broken) conn.destroy(); else conn.release();
  }
}

// Two people moving devices at the same moment can deadlock each other in the
// database (or race for the same pond); one of them is rolled back and simply
// tries again.
async function withRetry(fn) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err.code === 'ER_LOCK_DEADLOCK' || err.code === 'ER_DUP_ENTRY') continue;
      throw err;
    }
  }
  throw lastErr;
}

// Moves a device that is already loaded AND locked (SELECT ... FOR UPDATE) by
// the caller's transaction into pondId, or unassigns it when pondId is null.
// `device` needs device_id, device_name and pond_id.
async function moveInTransaction(conn, { device, farmId, pondId }) {
  let target = null;
  if (pondId !== null) {
    const id = Number(pondId);
    // Scoped to the caller's farm: another farm's pond answers exactly like
    // a pond that does not exist (no id probing).
    const [ponds] = await conn.query(
      'SELECT pond_id, pond_name FROM ponds WHERE pond_id = ? AND farm_id = ? FOR UPDATE',
      [Number.isInteger(id) ? id : 0, farmId]
    );
    if (!ponds.length) throw new AssignmentError(404, 'Pond not found in your farm');
    target = ponds[0];
  }

  let previousPondName = null;
  if (device.pond_id) {
    const [prev] = await conn.query('SELECT pond_name FROM ponds WHERE pond_id = ?', [device.pond_id]);
    previousPondName = prev[0]?.pond_name ?? null;
  }

  const result = {
    device_id: device.device_id,
    device_name: device.device_name,
    pond_id: target ? target.pond_id : null,
    pond_name: target ? target.pond_name : null,
    previous_pond_id: device.pond_id ?? null,
    previous_pond_name: previousPondName,
    changed: false,
    displaced_device: null,
  };

  const same = (device.pond_id ?? null) === (target ? target.pond_id : null);
  if (same) return result;

  if (target) {
    const [occupants] = await conn.query(
      'SELECT device_id, device_name FROM monitoring_devices WHERE pond_id = ? AND device_id <> ? FOR UPDATE',
      [target.pond_id, device.device_id]
    );
    if (occupants.length) {
      await conn.query(
        'UPDATE monitoring_devices SET pond_id = NULL, assigned_at = NULL WHERE pond_id = ? AND device_id <> ?',
        [target.pond_id, device.device_id]
      );
      result.displaced_device = { device_id: occupants[0].device_id, device_name: occupants[0].device_name };
    }
    await conn.query(
      'UPDATE monitoring_devices SET pond_id = ?, assigned_at = NOW() WHERE device_id = ?',
      [target.pond_id, device.device_id]
    );
  } else {
    await conn.query(
      'UPDATE monitoring_devices SET pond_id = NULL, assigned_at = NULL WHERE device_id = ?',
      [device.device_id]
    );
  }

  result.changed = true;
  return result;
}

async function tryAssign({ deviceId, farmId, pondId }) {
  return inTransaction(async (conn) => {
    const [devs] = await conn.query(
      'SELECT device_id, device_name, pond_id FROM monitoring_devices WHERE device_id = ? AND farm_id = ? FOR UPDATE',
      [deviceId, farmId]
    );
    if (!devs.length) throw new AssignmentError(404, 'Device not found');
    return moveInTransaction(conn, { device: devs[0], farmId, pondId });
  });
}

// pondId: a pond id to move the device into, or null to unassign it.
async function assignDevice({ deviceId, farmId, pondId }) {
  return withRetry(() => tryAssign({ deviceId, farmId, pondId }));
}

// ---------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------

// Plain-language reasons shown in the app. They never contain a Device Key.
const MSG_ID_TAKEN_OTHER_FARM =
  'This Device ID is already registered to another account. Check the Device ID printed on the device box. If it is correct, its current owner has to remove the device from their account first.';
const MSG_ID_TAKEN_DIFFERENT_KEY =
  'A device with this Device ID already exists but with a different Device Key. Check that the Device ID and the Device Key you typed are the two values printed on the same device box.';
const MSG_KEY_IN_USE =
  'This Device Key already belongs to a different device. Every device has its own Device Key, so check the key printed on this device\'s box.';

// A duplicate-entry error says WHICH unique index was hit. mysql2 words it as
// "... for key 'device_key'" (MariaDB / older MySQL) or "... for key
// 'monitoring_devices.device_key'" (MySQL 8). Only the index name is looked at:
// the message also contains the typed key, which must never be logged or returned.
function duplicateIndex(err) {
  const m = /for key '(?:[^']*\.)?([^']+)'/.exec(err && err.sqlMessage ? err.sqlMessage : '');
  return m ? m[1] : null;
}

// One registration at a time (see inTransaction). Moving or removing a device does not use it.
const REGISTRATION_LOCK = 'hyqual_device_registration';

async function tryRegister({ deviceId, deviceKey, farmId, pondId, deviceName }) {
  return inTransaction(async (conn) => {
    // 1. Is this Device ID already in the database? Registrations run one at a time
    //    (REGISTRATION_LOCK), so two people registering the same Device ID, or the same
    //    Device Key, at the same moment are handled one after the other: only the first
    //    can win and the second is told why. The row is still locked in the same order
    //    every other move uses (device, pond, occupant) against a concurrent move.
    const [devs] = await conn.query(
      'SELECT device_id, device_name, device_key, farm_id, pond_id FROM monitoring_devices WHERE device_id = ? FOR UPDATE',
      [deviceId]
    );
    const existing = devs[0];
    let name = deviceName || defaultDeviceName(deviceId);

    if (existing) {
      // ---- duplicate Device ID ----
      if (existing.farm_id !== null && existing.farm_id !== undefined) {
        if (Number(existing.farm_id) === Number(farmId)) {
          let where = '';
          if (existing.pond_id) {
            const [p] = await conn.query('SELECT pond_name FROM ponds WHERE pond_id = ?', [existing.pond_id]);
            if (p.length) where = ` (on ${p[0].pond_name})`;
          }
          throw new AssignmentError(
            409,
            `Device ID ${deviceId} (${existing.device_name}) is already registered in your farm${where}. To use it in another pond, open Devices and choose Manage on it.`,
            'DEVICE_ALREADY_REGISTERED'
          );
        }
        throw new AssignmentError(409, MSG_ID_TAKEN_OTHER_FARM, 'DEVICE_ALREADY_REGISTERED');
      }

      // The row exists but belongs to no farm (a device a farmer removed earlier, or one
      // made by scripts/provision_device.js). It may only be re-registered with ITS key.
      if (!keysMatch(existing.device_key, deviceKey)) {
        throw new AssignmentError(409, MSG_ID_TAKEN_DIFFERENT_KEY, 'DEVICE_ID_CONFLICT');
      }
      const [claimed] = await conn.query(
        'UPDATE monitoring_devices SET farm_id = ?, device_name = ?, installed_at = NOW() WHERE device_id = ? AND farm_id IS NULL',
        [farmId, name, deviceId]
      );
      if (!claimed.affectedRows) {
        throw new AssignmentError(409, 'This device was just registered by someone else.', 'DEVICE_ALREADY_REGISTERED');
      }
    } else {
      // ---- a NEW device: the Device Key must not belong to another device ----
      // The ESP32 identifies itself to the API by this key alone, so two devices
      // can never share one (the column is UNIQUE; this check just explains it).
      const [keyOwners] = await conn.query(
        'SELECT device_id FROM monitoring_devices WHERE device_key = ? LIMIT 1 FOR UPDATE',
        [deviceKey]
      );
      if (keyOwners.length) {
        throw new AssignmentError(409, MSG_KEY_IN_USE, 'DEVICE_KEY_IN_USE');
      }

      // ---- create the device record: the printed ID + key, this farm, no pond yet ----
      // device_id is given explicitly (AUTO_INCREMENT only picks a number when none is
      // given, so the printed Device ID is stored exactly as it is on the box).
      await conn.query(
        `INSERT INTO monitoring_devices (device_id, farm_id, pond_id, assigned_at, device_name, status, device_key)
         VALUES (?, ?, NULL, NULL, ?, 'active', ?)`,
        [deviceId, farmId, name, deviceKey]
      );
    }

    // 2. Put it in the chosen pond with the same step every other move uses (checks the
    //    pond belongs to this farm, stamps assigned_at, enforces one device per pond).
    //    If the pond is not in the farm this throws and the INSERT above is rolled back.
    const move = await moveInTransaction(conn, {
      device: { device_id: deviceId, device_name: name, farm_id: farmId, pond_id: null },
      farmId,
      pondId,
    });

    // 3. Every device has exactly one current-status row (OFFLINE until the ESP32 first
    //    talks to the API). Only created when missing; never touches a reporting device.
    await conn.query(
      `INSERT INTO device_status (device_id, connectivity_status, active_sensors_count, recorded_at, last_seen_at)
       VALUES (?, 'offline', 0, NOW(), NULL)
       ON DUPLICATE KEY UPDATE device_id = device_id`,
      [deviceId]
    );
    return move;
  }, REGISTRATION_LOCK);
}

// Best effort: a failed log line must never undo or block a registration.
async function logDeviceEvent(accountId, actionType, description) {
  if (!accountId) return;
  try {
    await pool.query(
      'INSERT INTO activity_logs (account_id, action_type, action_description) VALUES (?, ?, ?)',
      [accountId, actionType, description]
    );
  } catch (err) {
    console.error('Could not write activity log:', err.code || err.message);
  }
}

// deviceId: the printed Device ID (a whole number 1..2147483647). deviceKey: the printed
// Device Key. farmId: the farm of the signed-in account. pondId: the pond chosen in the
// app (must be one of farmId's ponds). deviceName: optional name (already trimmed and
// length-checked); without one the device is called "Device <id>". All of them are
// validated by utils/deviceInput.js before this is called.
//
// CREATES the monitoring_devices record (or re-registers an unregistered one whose key
// matches) and resolves with the same shape as assignDevice (device_id, device_name,
// pond_id, pond_name, displaced_device ...). Never resolves with, or logs, the key.
// Rejects with an AssignmentError:
//   404                          pond not in this farm
//   409 DEVICE_ALREADY_REGISTERED  this Device ID is registered (to this farm or another)
//   409 DEVICE_ID_CONFLICT         the Device ID exists, unregistered, with a different key
//   409 DEVICE_KEY_IN_USE          the Device Key belongs to another device
// Any other error is a database failure and is left for the route to explain.
async function registerDevice({ deviceId, deviceKey, farmId, pondId, accountId, deviceName }) {
  let move;
  try {
    move = await withRetry(() => tryRegister({ deviceId, deviceKey, farmId, pondId, deviceName }));
  } catch (err) {
    // Still a duplicate after the retries (someone else took the same ID / key / pond at
    // the same moment): say which one it was instead of a vague database error.
    if (err && err.code === 'ER_DUP_ENTRY') {
      const index = duplicateIndex(err);
      if (index === 'device_key') throw new AssignmentError(409, MSG_KEY_IN_USE, 'DEVICE_KEY_IN_USE');
      if (index === 'PRIMARY') {
        throw new AssignmentError(409, 'A device with this Device ID was just registered by someone else.', 'DEVICE_ALREADY_REGISTERED');
      }
    }
    throw err;
  }
  await logDeviceEvent(
    accountId,
    'device_registered',
    `Registered device #${move.device_id} (${move.device_name}) to pond "${move.pond_name}" (farm #${farmId}).`
  );
  return move;
}

// ---------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------

async function tryUnregister({ deviceId, farmId }) {
  return inTransaction(async (conn) => {
    const [devs] = await conn.query(
      'SELECT device_id, device_name, pond_id FROM monitoring_devices WHERE device_id = ? AND farm_id = ? FOR UPDATE',
      [deviceId, farmId]
    );
    if (!devs.length) throw new AssignmentError(404, 'Device not found');
    const device = devs[0];

    let previousPondName = null;
    if (device.pond_id) {
      const [prev] = await conn.query('SELECT pond_name FROM ponds WHERE pond_id = ?', [device.pond_id]);
      previousPondName = prev[0]?.pond_name ?? null;
    }

    // Back to "provisioned, not registered": no farm, no pond, and the default name
    // again so one farm's custom name is not handed to the next owner. device_id and
    // device_key are NOT touched: they are permanent. Readings keep their device_id and pond_id.
    await conn.query(
      `UPDATE monitoring_devices
          SET farm_id = NULL, pond_id = NULL, assigned_at = NULL, status = 'active',
              device_name = CONCAT('Device ', device_id)
        WHERE device_id = ?`,
      [device.device_id]
    );

    // The farm's alerts stay as its history, but they stop pointing at a device
    // that can now belong to somebody else (the same as when a device row used to be
    // deleted), and a "Device Offline" alert for a device the farmer removed is over.
    await conn.query(
      `UPDATE early_warning_notifications SET is_resolved = 1
        WHERE device_id = ? AND farm_id = ? AND parameter IS NULL AND title = ? AND is_resolved = 0`,
      [device.device_id, farmId, OFFLINE_TITLE]
    );
    await conn.query(
      'UPDATE early_warning_notifications SET device_id = NULL WHERE device_id = ? AND farm_id = ?',
      [device.device_id, farmId]
    );

    return {
      device_id: device.device_id,
      device_name: device.device_name,
      previous_pond_id: device.pond_id ?? null,
      previous_pond_name: previousPondName,
    };
  });
}

async function unregisterDevice({ deviceId, farmId, accountId }) {
  const out = await withRetry(() => tryUnregister({ deviceId, farmId }));
  await logDeviceEvent(
    accountId,
    'device_unregistered',
    `Removed device #${out.device_id} (${out.device_name}) from farm #${farmId}${out.previous_pond_name ? ` (it was on pond "${out.previous_pond_name}")` : ''}.`
  );
  return out;
}

// The reply the app gets after a move: what happened, plus the status of the
// pond that was left and of the pond that was entered, so the screen can
// update at once.
async function describeMove(farmId, move) {
  const [pond, previousPond] = await Promise.all([
    pondSnapshot(farmId, move.pond_id),
    move.previous_pond_id && move.previous_pond_id !== move.pond_id ? pondSnapshot(farmId, move.previous_pond_id) : null,
  ]);
  return { ...move, pond, previous_pond: previousPond };
}

module.exports = { assignDevice, registerDevice, unregisterDevice, describeMove, AssignmentError };
