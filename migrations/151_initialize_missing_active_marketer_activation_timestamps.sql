-- Active marketers whose activation timestamp was never recorded begin earning network BV
-- from this repair time. Do not backfill their historical orders: those sales predate this
-- timestamp and must not be credited retroactively. Existing finalized settlements are untouched.
UPDATE app_profiles
   SET activation_started_at = now()
 WHERE role = 'marketer'
   AND status = 'active'
   AND activation_started_at IS NULL
   AND COALESCE(activation_blocked, false) = false
   AND deleted_at IS NULL;