// Checks the body of POST /api/devices (registering a device) BEFORE anything
// touches the database. Pure functions, no database and no Express, so they are
// easy to test and the route stays short.
//
// The Device ID and the Device Key are the values PRINTED ON THE DEVICE'S BOX and
// programmed into its ESP32. The app only passes them on; nothing here (or anywhere
// in the registration) generates or changes them.
//
// Limits come from monitoring_devices:
//   device_id    INT (signed, AUTO_INCREMENT)  -> 1 .. 2147483647. 0 is refused on
//                purpose: MySQL treats an explicit 0 in an AUTO_INCREMENT column as
//                "give me the next number", which would silently invent an ID.
//   device_key   VARCHAR(64)                   -> at most 64 characters
//   device_name  VARCHAR(100)                  -> at most 100 characters
//
// The key is also the ESP32's password for POST /ingest/readings, so a very short
// one is refused. Keys issued so far are "dk_" + 32 hex characters (35 characters).
// Lower MIN_DEVICE_KEY_LENGTH if your printed keys are ever shorter than this.

const MAX_DEVICE_ID = 2147483647;
const MIN_DEVICE_KEY_LENGTH = 16;
const MAX_DEVICE_KEY_LENGTH = 64;
const MAX_DEVICE_NAME_LENGTH = 100;

function fail(status, code, error) {
  return { ok: false, status, code, error };
}

// What a request field may be: a string, or (for the Device ID) a number.
function asText(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null; // object, array, boolean ... : never turn those into text
}

// body: the parsed JSON of the request. authFarmId: the farm of the signed-in
// account (from the token). Returns
//   { ok: true, deviceId, deviceKey, deviceName, pondId, farmId }   (deviceName '' when not given)
// or
//   { ok: false, status, code, error }                               (error = sentence for the app)
function validateRegistrationInput(body, authFarmId) {
  const b = body && typeof body === 'object' ? body : {};

  // ---- Device ID ----
  const idRaw = b.deviceId;
  if (idRaw === undefined || idRaw === null || (typeof idRaw === 'string' && !idRaw.trim())) {
    return fail(400, 'DEVICE_ID_REQUIRED', 'Enter the Device ID printed on the device box.');
  }
  const idText = asText(idRaw);
  if (idText === null || !/^\d{1,10}$/.test(idText)) {
    return fail(400, 'INVALID_DEVICE_ID', 'The Device ID is a whole number (for example 8). Check the label on the device box.');
  }
  const deviceId = Number(idText);
  if (deviceId < 1 || deviceId > MAX_DEVICE_ID) {
    return fail(400, 'INVALID_DEVICE_ID', `The Device ID must be a whole number from 1 to ${MAX_DEVICE_ID}. Check the label on the device box.`);
  }

  // ---- Device Key ----
  const keyRaw = b.deviceKey;
  if (keyRaw === undefined || keyRaw === null || (typeof keyRaw === 'string' && !keyRaw.trim())) {
    return fail(400, 'DEVICE_KEY_REQUIRED', 'Enter the Device Key printed on the device box.');
  }
  if (typeof keyRaw !== 'string') {
    return fail(400, 'INVALID_DEVICE_KEY', 'The Device Key must be the text printed on the device box.');
  }
  const deviceKey = keyRaw.trim();
  if (deviceKey.length < MIN_DEVICE_KEY_LENGTH) {
    return fail(400, 'INVALID_DEVICE_KEY', `That Device Key is too short (at least ${MIN_DEVICE_KEY_LENGTH} characters). Check the label on the device box.`);
  }
  if (deviceKey.length > MAX_DEVICE_KEY_LENGTH) {
    return fail(400, 'INVALID_DEVICE_KEY', `That Device Key is too long (at most ${MAX_DEVICE_KEY_LENGTH} characters). Check the label on the device box.`);
  }
  if (!/^[\x21-\x7E]+$/.test(deviceKey)) {
    return fail(400, 'INVALID_DEVICE_KEY', 'The Device Key cannot contain spaces or special characters. Type it exactly as printed on the device box.');
  }

  // ---- Device Name (optional for the API; the app always sends one) ----
  let deviceName = '';
  if (b.deviceName !== undefined && b.deviceName !== null) {
    if (typeof b.deviceName !== 'string') {
      return fail(400, 'INVALID_DEVICE_NAME', 'The device name must be text.');
    }
    deviceName = b.deviceName.trim();
    if (deviceName.length > MAX_DEVICE_NAME_LENGTH) {
      return fail(400, 'DEVICE_NAME_TOO_LONG', `The device name can be at most ${MAX_DEVICE_NAME_LENGTH} characters.`);
    }
  }

  // ---- Pond ----
  const pondRaw = b.pondId;
  if (pondRaw === undefined || pondRaw === null || (typeof pondRaw === 'string' && !pondRaw.trim())) {
    return fail(400, 'POND_REQUIRED', 'Select the pond where the device will be installed.');
  }
  const pondText = asText(pondRaw);
  const pondId = pondText !== null && /^\d{1,10}$/.test(pondText) ? Number(pondText) : NaN;
  if (!Number.isInteger(pondId) || pondId < 1 || pondId > MAX_DEVICE_ID) {
    return fail(400, 'POND_NOT_FOUND', 'Pond does not exist in your farm');
  }

  // ---- Farm (optional cross-check) ----
  // The farm that gets the device is ALWAYS the signed-in account's own farm (from
  // the token). The app also sends the farm it is showing; if that is not the
  // caller's farm the request is refused instead of silently using another one.
  const farmRaw = b.farmId;
  let farmId = Number(authFarmId);
  if (!(farmRaw === undefined || farmRaw === null || (typeof farmRaw === 'string' && !farmRaw.trim()))) {
    const farmText = asText(farmRaw);
    if (farmText === null || !/^\d{1,10}$/.test(farmText)) {
      return fail(400, 'INVALID_FARM_ID', 'The farm is not valid.');
    }
    if (Number(farmText) !== Number(authFarmId)) {
      return fail(403, 'FARM_MISMATCH', 'That farm does not belong to your account.');
    }
    farmId = Number(farmText);
  }

  return { ok: true, deviceId, deviceKey, deviceName, pondId, farmId };
}

module.exports = {
  MAX_DEVICE_ID,
  MIN_DEVICE_KEY_LENGTH,
  MAX_DEVICE_KEY_LENGTH,
  MAX_DEVICE_NAME_LENGTH,
  validateRegistrationInput,
};
