CREATE UNIQUE INDEX IF NOT EXISTS commission_rules_name_uq ON commission_rules(name);

INSERT INTO commission_rules(id,name,level,rate,active)
VALUES(gen_random_uuid(),'direct_commission_amount',250,0,true)
ON CONFLICT(name) DO NOTHING;
INSERT INTO commission_rules(id,name,level,rate,active)
VALUES(gen_random_uuid(),'weekly_check_amount',1500,0,true)
ON CONFLICT(name) DO NOTHING;
INSERT INTO commission_rules(id,name,level,rate,active)
VALUES(gen_random_uuid(),'automatic_update_enabled',0,1,true)
ON CONFLICT(name) DO NOTHING;

CREATE OR REPLACE FUNCTION credit_direct_commission_for_order(p_order_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
DECLARE
  sponsor text;
  commission_value numeric(12,2);
BEGIN
  SELECT COALESCE((SELECT level::numeric FROM commission_rules WHERE name='direct_commission_amount' LIMIT 1),250)
    INTO commission_value;

  SELECT buyer.sponsor_id::text INTO sponsor
    FROM orders o JOIN app_profiles buyer ON buyer.id=o.marketer_id
   WHERE o.id=p_order_id AND o.status='paid'
     AND buyer.role='marketer' AND buyer.deleted_at IS NULL AND buyer.sponsor_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM order_items oi JOIN products pr ON pr.id=oi.product_id
                  WHERE oi.order_id=o.id AND pr.commissionable=true)
   LIMIT 1;
  IF sponsor IS NULL THEN RETURN false; END IF;
  INSERT INTO network_direct_commissions(marketer_id,order_id,amount,status)
  VALUES(sponsor,p_order_id,commission_value,'pending')
  ON CONFLICT(marketer_id,order_id) DO NOTHING;
  RETURN true;
END;
$function$;