-- Admin-only server-side balance projection. Read the same spendable balance
-- as the marketer wallet API while bypassing wallet-table RLS for admin reports.
CREATE OR REPLACE FUNCTION get_admin_marketer_wallet_balance(p_user_id text)
RETURNS numeric
LANGUAGE sql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM app_profiles a
      WHERE a.id::text = p_user_id AND a.role = 'marketer'
    ) THEN 0::numeric
    WHEN EXISTS (SELECT 1 FROM wallets w WHERE w.user_id::text = p_user_id)
      AND (
        COALESCE((SELECT w.balance FROM wallets w WHERE w.user_id::text = p_user_id LIMIT 1), 0) <> 0
        OR EXISTS (SELECT 1 FROM wallet_transactions wt WHERE wt.user_id::text = p_user_id)
      )
      THEN COALESCE((SELECT w.balance FROM wallets w WHERE w.user_id::text = p_user_id LIMIT 1), 0)::numeric
    ELSE COALESCE((
      SELECT SUM(CASE WHEN ma.action = 'remove' THEN -ABS(ma.amount) ELSE ABS(ma.amount) END)
      FROM admin_manual_wallet_actions ma
      WHERE ma.marketer_id::text = p_user_id
    ), 0)::numeric
  END;
$function$;