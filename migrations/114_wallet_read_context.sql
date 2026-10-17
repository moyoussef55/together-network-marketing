-- Read the marketer wallet and ledger through a single scoped SECURITY DEFINER function.
-- This keeps the custom Together session compatible with row-level security.
CREATE OR REPLACE FUNCTION get_marketer_wallet_state(p_user_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
DECLARE
  previous_hatchable_user text;
  previous_wallet_user text;
  result jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app_profiles
    WHERE id::text = p_user_id AND role = 'marketer'
      AND deleted_at IS NULL AND COALESCE(login_blocked, false) = false
  ) THEN
    RAISE EXCEPTION 'marketer_not_found';
  END IF;
  previous_hatchable_user := current_setting('hatchable.user_id', true);
  previous_wallet_user := current_setting('together.wallet_user_id', true);
  PERFORM set_config('hatchable.user_id', p_user_id, true);
  PERFORM set_config('together.wallet_user_id', p_user_id, true);

  SELECT jsonb_build_object(
    'wallet_found', EXISTS(SELECT 1 FROM wallets WHERE user_id::text = p_user_id),
    'balance', COALESCE((SELECT balance FROM wallets WHERE user_id::text = p_user_id), 0),
    'transactions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', id, 'type', type,
        'amount', CASE WHEN type IN ('store_purchase','withdrawal','admin_remove','wallet_debit','purchase') THEN -ABS(amount) ELSE amount END,
        'direction', CASE WHEN type IN ('store_purchase','withdrawal','admin_remove','wallet_debit','purchase') OR amount < 0 THEN 'out' ELSE 'in' END,
        'reference', reference, 'created_at', created_at
      ) ORDER BY created_at DESC)
      FROM wallet_transactions WHERE user_id::text = p_user_id
    ), '[]'::jsonb)
  ) INTO result;

  PERFORM set_config('hatchable.user_id', COALESCE(previous_hatchable_user, ''), true);
  PERFORM set_config('together.wallet_user_id', COALESCE(previous_wallet_user, ''), true);
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('hatchable.user_id', COALESCE(previous_hatchable_user, ''), true);
  PERFORM set_config('together.wallet_user_id', COALESCE(previous_wallet_user, ''), true);
  RAISE;
END;
$function$;