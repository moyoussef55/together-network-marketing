-- Permit the SECURITY DEFINER admin decision function to lock and update withdrawal rows.
-- The existing queue policy only grants SELECT, so SELECT ... FOR UPDATE can hide
-- rows under RLS and the API incorrectly reports withdrawal_not_found.
DROP POLICY IF EXISTS together_admin_withdrawal_queue_update ON withdrawal_requests;
CREATE POLICY together_admin_withdrawal_queue_update
ON withdrawal_requests
FOR UPDATE
USING (current_setting('together.admin_withdrawals_access', true) = 'true')
WITH CHECK (current_setting('together.admin_withdrawals_access', true) = 'true');