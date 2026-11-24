-- =====================================================================
-- 006_device_provisioning.sql
--
-- For an EXISTING database (local or Railway). A brand-new database does
-- not need this: schema.sql already contains everything below.
--
-- Supports the new device registration process. Every physical device is
-- PROVISIONED once (scripts/provision_device.js) with a permanent Device ID
-- and Device Key that are printed on its box and programmed into the ESP32.
-- A farmer then only TYPES those two values into the app; nothing is
-- generated when a user registers a device any more.
--
-- ONE change. Nothing is dropped, renamed or rewritten:
--
--   monitoring_devices.farm_id   NOT NULL  ->  NULL allowed
--
-- monitoring_devices stays the central record of devices and their
-- permanent credentials (device_id + device_key). A device that has been
-- provisioned but not registered yet has no farm and no pond:
--
--   farm_id IS NULL      = provisioned, waiting to be registered
--   farm_id IS NOT NULL  = registered to that farm
--
-- Registering a device (POST /api/devices) sets farm_id and pond_id in one
-- step; removing a device from a farm sets them back to NULL and keeps the
-- row, its credentials, its readings and its status.
--
-- Every device that exists today already belongs to a farm, so all of them
-- stay registered exactly as they are. They keep the Device ID and Device
-- Key already programmed into their ESP32, plus their readings, status
-- rows, alerts and pond. No firmware has to be re-flashed.
--
-- The foreign key to aquaculture_farms is left as it was (ON DELETE
-- CASCADE): deleting a whole farm still deletes that farm's devices, as before.
--
-- Safe to run more than once. Take a Railway backup first if the database
-- holds real data.
--
--     node scripts/run_sql.js database/migrations/006_device_provisioning.sql
-- =====================================================================

SET @fk_checks = @@FOREIGN_KEY_CHECKS;
SET FOREIGN_KEY_CHECKS = 0;

SET @q = IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'monitoring_devices'
      AND column_name = 'farm_id' AND is_nullable = 'NO') > 0,
  'ALTER TABLE monitoring_devices MODIFY COLUMN farm_id INT NULL DEFAULT NULL',
  'SELECT ''monitoring_devices: farm_id already allows NULL'' AS info');
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET FOREIGN_KEY_CHECKS = @fk_checks;

-- ---------------------------------------------------------------------
-- Verification (read-only)
-- ---------------------------------------------------------------------
SELECT 'monitoring_devices.farm_id allows NULL' AS object_name, COUNT(*) AS present
  FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'monitoring_devices'
    AND column_name = 'farm_id' AND is_nullable = 'YES';
-- present must be 1.

SELECT SUM(farm_id IS NOT NULL) AS registered_devices,
       SUM(farm_id IS NULL)     AS provisioned_waiting_for_registration
  FROM monitoring_devices;
-- Right after the migration every existing device is still registered, so the
-- second number is 0 until you run scripts/provision_device.js.
