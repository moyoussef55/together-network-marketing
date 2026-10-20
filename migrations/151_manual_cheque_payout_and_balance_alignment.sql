-- Make weekly cheque credits safe for both manual payouts and the scheduled settlement.
-- A cheque is credited once; if the same period's calculated amount later increases,
-- only the positive difference is added to the wallet.
CREATE OR REPLACE FUNCTION credit_weekly_check_to_wallet(
  p_user_id text,
  p_amount numeric,
  p_reference text
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  previous_hatchable_user text;
  previous_wallet_user text;
  existing_tx_id uuid;
  existing_amount numeric;
  credited_tx uuid;
  changed boolean := false;
BEGIN
  IF COALESCE(p_amount,0) <= 0
     OR COALESCE(p_user_id,'') = ''
     OR COALESCE(p_reference,'') NOT LIKE 'weekly-check:%' THEN
    RETURN false;
  END IF;

  previous_hatchable_user := current_setting('hatchable.user_id',true);
  previous_wallet_user := current_setting('together.wallet_user_id',true);
  PERFORM set_config('hatchable.user_id',p_user_id,true);
  PERFORM set_config('together.wallet_user_id',p_user_id,true);

  -- Serialize payments for this member, including when a wallet row must be created.
  INSERT INTO wallets(user_id,balance)
  VALUES(p_user_id,0)
  ON CONFLICT(user_id) DO NOTHING;
  PERFORM 1 FROM wallets WHERE user_id::text=p_user_id FOR UPDATE;

  SELECT id,amount
    INTO existing_tx_id,existing_amount
    FROM wallet_transactions
   WHERE user_id::text=p_user_id AND reference=p_reference
   FOR UPDATE;

  IF existing_tx_id IS NULL THEN
    INSERT INTO wallet_transactions(user_id,type,amount,reference)
    VALUES(p_user_id,'weekly_check',p_amount,p_reference)
    ON CONFLICT(user_id,reference)
      WHERE reference LIKE 'weekly-check:%'
    DO NOTHING
    RETURNING id INTO credited_tx;

    IF credited_tx IS NOT NULL THEN
      UPDATE wallets
         SET balance=COALESCE(balance,0)+p_amount,updated_at=now()
       WHERE user_id::text=p_user_id;
      changed := true;
    ELSE
      -- Defensive retry for a credit created by a concurrent older caller.
      SELECT id,amount
        INTO existing_tx_id,existing_amount
        FROM wallet_transactions
       WHERE user_id::text=p_user_id AND reference=p_reference
       FOR UPDATE;
      IF existing_tx_id IS NOT NULL AND p_amount>COALESCE(existing_amount,0) THEN
        UPDATE wallet_transactions SET amount=p_amount WHERE id=existing_tx_id;
        UPDATE wallets
           SET balance=COALESCE(balance,0)+(p_amount-COALESCE(existing_amount,0)),updated_at=now()
         WHERE user_id::text=p_user_id;
        changed := true;
      END IF;
    END IF;
  ELSIF p_amount>COALESCE(existing_amount,0) THEN
    UPDATE wallet_transactions SET amount=p_amount WHERE id=existing_tx_id;
    UPDATE wallets
       SET balance=COALESCE(balance,0)+(p_amount-COALESCE(existing_amount,0)),updated_at=now()
     WHERE user_id::text=p_user_id;
    changed := true;
  END IF;

  PERFORM set_config('hatchable.user_id',COALESCE(previous_hatchable_user,''),true);
  PERFORM set_config('together.wallet_user_id',COALESCE(previous_wallet_user,''),true);
  RETURN changed;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('hatchable.user_id',COALESCE(previous_hatchable_user,''),true);
  PERFORM set_config('together.wallet_user_id',COALESCE(previous_wallet_user,''),true);
  RAISE;
END;
$$;

-- Run weekly BV settlement inside one database call. Manual runs pay immediately;
-- the scheduled run uses the same unique cheque reference and only tops up increases.
-- Existing settlement timestamps and the weekly schedule are preserved.
CREATE OR REPLACE FUNCTION settle_network_weekly_checks(
  p_week_start date,
  p_week_end date,
  p_check_rate numeric,
  p_manual boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  a record;
  period_right bigint;
  period_left bigint;
  right_value bigint;
  left_value bigint;
  matched bigint;
  carry_right_value bigint;
  carry_left_value bigint;
  calculated_amount numeric;
  payout numeric;
  flash_out boolean;
  max_out boolean;
  settled_count integer := 0;
  check_count integer := 0;
  settlement_id bigint;
BEGIN
  FOR a IN
    SELECT b.member_id,b.account_position,COALESCE(b.carry_right,0) AS carry_right,
           COALESCE(b.carry_left,0) AS carry_left
      FROM network_bv_balances b
     WHERE b.total_right>0 OR b.total_left>0 OR b.carry_right>0 OR b.carry_left>0
        OR EXISTS (
          SELECT 1 FROM network_bv_settlements s
           WHERE s.member_id=b.member_id AND s.account_position=b.account_position
             AND s.week_start=p_week_start AND s.week_end=p_week_end AND s.is_finalized=false
        )
  LOOP
    IF NOT p_manual AND EXISTS (
      SELECT 1 FROM network_bv_settlements s
       WHERE s.member_id=a.member_id AND s.account_position=a.account_position
         AND s.week_start=p_week_start AND s.week_end=p_week_end AND s.is_finalized=true
    ) THEN
      CONTINUE;
    END IF;

    SELECT COALESCE(SUM(l.bv) FILTER(WHERE l.side='right'),0)::bigint,
           COALESCE(SUM(l.bv) FILTER(WHERE l.side='left'),0)::bigint
      INTO period_right,period_left
      FROM network_bv_ledger l
     WHERE l.upline_member_id=a.member_id AND l.account_position=a.account_position
       AND l.sale_at >= (p_week_start::timestamp AT TIME ZONE 'Africa/Cairo')
       AND l.sale_at < (p_week_end::timestamp AT TIME ZONE 'Africa/Cairo');

    right_value := COALESCE(period_right,0)+COALESCE(a.carry_right,0);
    left_value := COALESCE(period_left,0)+COALESCE(a.carry_left,0);
    matched := floor(LEAST(right_value,left_value)::numeric/3000)*3000;
    flash_out := matched>=24000;
    max_out := matched>=21000 AND matched<24000;
    calculated_amount := (matched/3000)*GREATEST(0,COALESCE(p_check_rate,1500));
    payout := CASE WHEN flash_out OR max_out THEN 10000 ELSE LEAST(10000,calculated_amount) END;
    carry_right_value := CASE WHEN flash_out THEN 0 ELSE right_value-matched END;
    carry_left_value := CASE WHEN flash_out THEN 0 ELSE left_value-matched END;

    INSERT INTO network_bv_settlements(
      member_id,account_position,week_start,week_end,right_bv,left_bv,matched_bv,
      check_amount,carry_right,carry_left,is_finalized,settled_at
    ) VALUES (
      a.member_id,a.account_position,p_week_start,p_week_end,right_value,left_value,matched,
      payout,carry_right_value,carry_left_value,NOT p_manual,
      (p_week_end::timestamp AT TIME ZONE 'Africa/Cairo')
    )
    ON CONFLICT(member_id,account_position,week_start,week_end) DO UPDATE SET
      right_bv=EXCLUDED.right_bv,left_bv=EXCLUDED.left_bv,matched_bv=EXCLUDED.matched_bv,
      check_amount=EXCLUDED.check_amount,carry_right=EXCLUDED.carry_right,carry_left=EXCLUDED.carry_left,
      is_finalized=EXCLUDED.is_finalized,
      settled_at=COALESCE(network_bv_settlements.settled_at,EXCLUDED.settled_at)
    RETURNING id INTO settlement_id;

    IF NOT p_manual THEN
      UPDATE network_bv_balances
         SET carry_right=carry_right_value,carry_left=carry_left_value,updated_at=now()
       WHERE member_id=a.member_id AND account_position=a.account_position;
    END IF;

    -- Manual runs pay the calculated cheque immediately. The same weekly reference
    -- makes the scheduled run idempotent; the helper credits only any later increase.
    IF payout>0 THEN
      PERFORM credit_weekly_check_to_wallet(
        a.member_id,payout,
        'weekly-check:'||p_week_end::text||':'||a.member_id||':'||a.account_position::text
      );
      check_count := check_count+1;
    END IF;
    settled_count := settled_count+1;
  END LOOP;

  RETURN jsonb_build_object('accounts',settled_count,'checks',check_count);
END;
$$;