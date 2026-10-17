-- Restore imported current wallet balances for merged marketers whose wallet row
-- was absent or an empty placeholder. Never overwrite a wallet that has activity.
DO $restore$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT ON (p.id)
           p.id::text AS user_id,
           COALESCE(NULLIF(s.payload->>'balance','')::numeric,0) AS balance
      FROM legacy_import_source_records s
      JOIN app_profiles p
        ON p.role='marketer'
       AND (
         p.id::text=s.source_id
         OR (NULLIF(s.payload->>'id','') IS NOT NULL AND p.legacy_member_code=s.payload->>'id')
         OR (NULLIF(s.payload->>'email','') IS NOT NULL AND lower(COALESCE(p.email,''))=lower(s.payload->>'email'))
       )
     WHERE s.collection_name='agents'
       AND COALESCE(NULLIF(s.payload->>'balance','')::numeric,0)<>0
       AND (
         NOT EXISTS (SELECT 1 FROM wallets w WHERE w.user_id::text=p.id::text)
         OR (
           EXISTS (SELECT 1 FROM wallets w WHERE w.user_id::text=p.id::text AND COALESCE(w.balance,0)=0)
           AND NOT EXISTS (SELECT 1 FROM wallet_transactions wt WHERE wt.user_id::text=p.id::text)
         )
       )
     ORDER BY p.id,
       CASE WHEN p.id::text=s.source_id THEN 0
            WHEN p.legacy_member_code=s.payload->>'id' THEN 1 ELSE 2 END
  LOOP
    PERFORM admin_set_marketer_wallet_balance(r.user_id,r.balance);
  END LOOP;
END
$restore$;

-- Keep the admin's displayed balance tied to the live wallet whenever there is
-- wallet activity; use the imported legacy balance only if no live wallet exists.
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
      THEN COALESCE((SELECT w.balance FROM wallets w WHERE w.user_id::text = p_user_id LIMIT 1),0)::numeric
    ELSE COALESCE((
      SELECT NULLIF(s.payload->>'balance','')::numeric
        FROM legacy_import_source_records s
        JOIN app_profiles a ON a.id::text=p_user_id AND a.role='marketer'
       WHERE s.collection_name='agents'
         AND (
           s.source_id=p_user_id
           OR (NULLIF(s.payload->>'id','') IS NOT NULL AND a.legacy_member_code=s.payload->>'id')
           OR (NULLIF(s.payload->>'email','') IS NOT NULL AND lower(COALESCE(a.email,''))=lower(s.payload->>'email'))
         )
       ORDER BY CASE WHEN s.source_id=p_user_id THEN 0
                     WHEN a.legacy_member_code=s.payload->>'id' THEN 1 ELSE 2 END
       LIMIT 1
    ),0)::numeric
  END;
$function$;