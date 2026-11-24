// Salinity units (decision: "make a conversion").
//
// The ESP32 does not measure salinity. It measures ELECTRICAL CONDUCTIVITY (EC)
// with an analog probe and sends it, in mS/cm, in the `salinity` field.
// Everything else in HyQual (the farm thresholds, the app, the Random Forest,
// the ARIMA models, the alert wording) means salinity in parts per thousand
// (ppt). Without a conversion a healthy 15 ppt pond (about 24 mS/cm) would be
// stored as "24" and shown as 24 ppt, and the ML service would classify it on
// the wrong scale. The conversion now happens in ONE place: the ingest route
// calls toPpt() before anything is stored, so the database, the app, the
// alerts and the ML service all see ppt.
//
// Method: UNESCO Practical Salinity Scale 1978 (PSS-78, Lewis 1980) with the
// Hill et al. (1986) extension for very low salinity. It is the international
// standard for turning seawater conductivity into salinity, so it can be cited
// in the defense. For a fresh-to-brackish pond it agrees within a few percent
// with the rule of thumb "ppt ~ 0.64 x mS/cm".
//
// TEMPERATURE: the firmware (readEC in the .ino) already compensates the EC to
// 25 C (it divides by 1 + 0.0185 x (T - 25)), so by default the EC is treated
// as the conductivity AT 25 C. Pass `tempC` only for an EC that was NOT
// compensated by the device.
//
// This is a calculation, not a calibration. The probe's own accuracy limits
// the result: calibrate it against a refractometer or a salinity standard
// before trusting a number to a tenth of a ppt.

const A = [0.0080, -0.1692, 25.3851, 14.0941, -7.0261, 2.7081];
const B = [0.0005, -0.0056, -0.0066, -0.0375, 0.0636, -0.0144];
const C = [0.6766097, 2.00564e-2, 1.104259e-4, -6.9698e-7, 1.0031e-9];
const K = 0.0162;
// Conductivity of standard seawater (S = 35, T = 15 C, P = 0), in mS/cm.
const C_35_15 = 42.914;

const REFERENCE_TEMP_C = 25;

function polynomial(coeffs, rt) {
  let sum = 0;
  for (let i = 0; i < coeffs.length; i++) sum += coeffs[i] * Math.pow(rt, i / 2);
  return sum;
}

/**
 * Practical salinity (PSS-78 + Hill extension) from conductivity.
 * @param {number} ecMsCm   conductivity in mS/cm at temperature tempC
 * @param {number} tempC    the temperature that conductivity belongs to (default 25 C)
 * @returns {number} salinity in ppt (practical salinity units), never negative
 */
function practicalSalinity(ecMsCm, tempC = REFERENCE_TEMP_C) {
  if (!Number.isFinite(ecMsCm) || !Number.isFinite(tempC)) return NaN;
  if (ecMsCm <= 0) return 0;

  const rtOfT = C[0] + tempC * (C[1] + tempC * (C[2] + tempC * (C[3] + tempC * C[4])));
  const rT = ecMsCm / C_35_15 / rtOfT; // conductivity ratio relative to standard seawater at T
  if (!(rT > 0)) return 0;

  const f = (tempC - 15) / (1 + K * (tempC - 15));
  let s = polynomial(A, rT) + f * polynomial(B, rT);

  // Hill et al. (1986): makes the scale go smoothly to 0 below about 2 ppt.
  const x = 400 * rT;
  const y = 100 * rT;
  s -= A[0] / (1 + 1.5 * x + x * x);
  s -= (B[0] * f) / (1 + Math.sqrt(y) + Math.pow(y, 1.5));

  return s < 0 ? 0 : s;
}

// Units the ingest route accepts for the `salinity` field.
//   key  = normalised unit text      value = how to read it
const UNITS = {
  'ms/cm': { kind: 'ec', toMsCm: 1 },
  'us/cm': { kind: 'ec', toMsCm: 0.001 },
  ppt: { kind: 'ppt' },
  psu: { kind: 'ppt' },
};

// Largest believable raw value per unit. A disconnected probe reads 0 or a huge
// number; anything above this is a sensor fault, not water chemistry.
const MAX_RAW = { 'ms/cm': 100, 'us/cm': 100000, ppt: 100, psu: 100 };

function normaliseUnit(raw) {
  if (raw === undefined || raw === null) return null;
  const u = String(raw).trim().toLowerCase().replace(/\u00b5|\u03bc/g, 'u').replace(/\s+/g, '');
  if (!u) return null;
  if (u === 'mscm' || u === 'ms/cm' || u === 'ms\\cm' || u === 'millisiemens/cm') return 'ms/cm';
  if (u === 'uscm' || u === 'us/cm' || u === 'microsiemens/cm') return 'us/cm';
  if (u === 'ppt' || u === 'psu' || u === 'g/kg' || u === '\u2030') return u === 'psu' ? 'psu' : 'ppt';
  return undefined; // text was given but is not a unit we know
}

/**
 * The unit a reading's `salinity` value is in. A device may say so with a
 * `salinityUnit` field. When it says nothing, DEFAULT_UNIT applies: the
 * firmware shipped with HyQual sends EC in mS/cm and never said so, so
 * mS/cm is the default (override with SALINITY_DEFAULT_UNIT).
 */
function defaultUnit() {
  const configured = normaliseUnit(process.env.SALINITY_DEFAULT_UNIT);
  return configured || 'ms/cm';
}

/**
 * Turns one reported salinity value into ppt.
 * @returns {{ value: number|null, ignored: boolean, converted: object|null }}
 *   value      ppt rounded to 2 decimals (the column is DECIMAL(5,2)), or null
 *   ignored    true when something WAS sent but could not be used
 *   converted  details of the conversion (null when the value was already ppt)
 */
function toPpt(raw, unit) {
  if (raw === undefined || raw === null || raw === '') return { value: null, ignored: false, converted: null };

  const key = unit === undefined || unit === null || unit === '' ? defaultUnit() : normaliseUnit(unit);
  if (!key || !UNITS[key]) return { value: null, ignored: true, converted: null }; // unknown unit: never guess
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > MAX_RAW[key]) return { value: null, ignored: true, converted: null };

  const spec = UNITS[key];
  if (spec.kind === 'ppt') return { value: n, ignored: false, converted: null };

  const ecMsCm = n * spec.toMsCm;
  const ppt = Math.round(practicalSalinity(ecMsCm) * 100) / 100;
  if (!Number.isFinite(ppt) || ppt < 0 || ppt > 100) return { value: null, ignored: true, converted: null };
  return {
    value: ppt,
    ignored: false,
    converted: { from: n, fromUnit: key === 'ms/cm' ? 'mS/cm' : '\u00b5S/cm', to: ppt, toUnit: 'ppt', method: 'PSS-78, EC at 25 C' },
  };
}

module.exports = { practicalSalinity, toPpt, normaliseUnit, defaultUnit };
