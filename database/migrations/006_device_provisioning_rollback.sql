-- Undo migration 006: puts monitoring_devices.farm_id back to NOT NULL.
--
-- This can only work while EVERY device belongs to a farm. If provisioned
-- devices are still waiting to be registered (farm_id IS NULL) this script
-- changes nothing and says so. It never deletes a device: register those
-- devices in the app first, or delete them yourself if you really mean to.
--
-- Note: after a rollback the old "name a device and get a key" screen would
-- no longer match the database, so only roll back together with the old app
-- and backend code.
SET @waiting = (SELECT COUNT(*) FROM monitoring_devices WHERE farm_id IS NULL);

SET @fk_checks = @@FOREIGN_KEY_CHECKS;
SET FOREIGN_KEY_CHECKS = 0;

SET @q = IF(
  @waiting > 0,
  'SELECT ''NOT rolled back: some provisioned devices are not registered to a farm yet (farm_id IS NULL). Register or remove them first.'' AS warning',
  IF((SELECT COUNT(*) FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'monitoring_devices'
          AND column_name = 'farm_id' AND is_nullable = 'YES') > 0,
     'ALTER TABLE monitoring_devices MODIFY COLUMN farm_id INT NOT NULL',
     'SELECT ''monitoring_devices: farm_id is already NOT NULL'' AS info'));
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET FOREIGN_KEY_CHECKS = @fk_checks;
SELECT 'rollback of 006 finished' AS info;
