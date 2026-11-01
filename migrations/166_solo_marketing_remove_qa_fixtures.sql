-- Quarantine the one QA profile created for checkout/commission idempotency testing.
-- Wallet history is append-only, so reverse the test credit through the audited wallet
-- adjustment routine rather than deleting historical wallet_transactions rows.
CREATE OR REPLACE FUNCTION cleanup_solo_marketing_qa_fixture()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
DECLARE
  old_hatchable_user text;
  old_wallet_user text;
  v_profile app_profiles%ROWTYPE;
BEGIN
  SELECT * INTO v_profile FROM app_profiles WHERE id='SOLO_MARKETING_QA_USER'
    AND referral_code='QA-SOLO-663' FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  old_hatchable_user := current_setting('hatchable.user_id',true);
  old_wallet_user := current_setting('together.wallet_user_id',true);
  PERFORM set_config('hatchable.user_id','SOLO_MARKETING_QA_USER',true);
  PERFORM set_config('together.wallet_user_id','SOLO_MARKETING_QA_USER',true);

  -- The test commission was exactly 25 EGP; reverse it through the audited
  -- wallet mutation helper. It refuses to debit more than the available balance.
  PERFORM admin_adjust_marketer_wallet(
    'SOLO_MARKETING_QA_USER',-25,'remove','solo-marketing-test-cleanup',
    'solo-marketing-qa-cleanup:SM-QA-663-0001'
  );

  UPDATE solo_marketing_orders
     SET deleted_at=COALESCE(deleted_at,now()),updated_at=now()
   WHERE order_code='SM-QA-663-0001';

  DELETE FROM solo_marketing_products
   WHERE id='ad3ad278-ca0f-49f7-8064-3426fc1161b2';

  UPDATE app_profiles
     SET role='customer',deleted_at=now(),status='deleted',login_blocked=true,
         display_name='Archived solo-marketing QA record'
   WHERE id='SOLO_MARKETING_QA_USER' AND referral_code='QA-SOLO-663';

  UPDATE solo_marketing_shipping_rates
     SET fee=0,active=false,updated_at=now()
   WHERE governorate='الإسكندرية' AND fee=47.50 AND active=true;

  PERFORM set_config('hatchable.user_id',COALESCE(old_hatchable_user,''),true);
  PERFORM set_config('together.wallet_user_id',COALESCE(old_wallet_user,''),true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('hatchable.user_id',COALESCE(old_hatchable_user,''),true);
  PERFORM set_config('together.wallet_user_id',COALESCE(old_wallet_user,''),true);
  RAISE;
END;
$function$;

SELECT cleanup_solo_marketing_qa_fixture();
DROP FUNCTION cleanup_solo_marketing_qa_fixture();