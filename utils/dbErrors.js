// Turns an UNEXPECTED database error from registering a device into a sentence the
// app can show, plus the HTTP status to send. Pure (no Express, no database), so it is
// easy to test. Business reasons (duplicate Device ID, duplicate Device Key, pond not in
// the farm ...) are AssignmentErrors raised in utils/deviceAssignment.js; this is only
// for what is left: the database being down, busy or refusing a value.
//
// Only the error CODE is ever read. mysql2's `message`, `sqlMessage` and `sql` contain the
// values that were typed, including the Device Key, so they are never logged or returned.

const BUSY = ['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'];
const UNAVAILABLE = [
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE', 'EAI_AGAIN',
  'PROTOCOL_CONNECTION_LOST', 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR', 'POOL_CLOSED',
  'ER_CON_COUNT_ERROR', 'ER_SERVER_SHUTDOWN', 'ER_CONNECTION_KILLED',
];
const MISSING_PARENT = ['ER_NO_REFERENCED_ROW', 'ER_NO_REFERENCED_ROW_2'];
const BAD_VALUE = [
  'ER_DATA_TOO_LONG', 'ER_WARN_DATA_OUT_OF_RANGE', 'ER_TRUNCATED_WRONG_VALUE',
  'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD', 'WARN_DATA_TRUNCATED',
];

// Returns { status, code, error, logCode }.  logCode is safe to write to the server log.
function describeRegistrationFailure(err) {
  const logCode = String((err && (err.code || err.errno)) || 'UNKNOWN');

  if (BUSY.includes(logCode)) {
    return { status: 503, code: 'DATABASE_BUSY', logCode,
      error: 'The database is busy right now. Nothing was saved. Please try again in a moment.' };
  }
  if (UNAVAILABLE.includes(logCode)) {
    return { status: 503, code: 'DATABASE_UNAVAILABLE', logCode,
      error: 'The server could not reach the database. Nothing was saved. Please try again in a moment.' };
  }
  if (MISSING_PARENT.includes(logCode)) {
    return { status: 409, code: 'FARM_OR_POND_MISSING', logCode,
      error: 'Your farm or pond could not be found any more. Reopen the app and try again.' };
  }
  if (BAD_VALUE.includes(logCode)) {
    return { status: 400, code: 'INVALID_DEVICE_INPUT', logCode,
      error: 'One of the values is too long or not valid. Check the Device ID, Device Key and Device Name.' };
  }
  return { status: 500, code: 'DATABASE_ERROR', logCode,
    error: 'The device could not be saved because of a database problem. Nothing was changed. Please try again, and if it keeps happening contact support.' };
}

module.exports = { describeRegistrationFailure };
