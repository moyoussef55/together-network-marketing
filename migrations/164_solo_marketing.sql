CREATE TABLE IF NOT EXISTS solo_marketing_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  short_description text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  image_key text,
  base_price numeric(12,2) NOT NULL CHECK (base_price >= 0),
  starting_price numeric(12,2) NOT NULL CHECK (starting_price >= 0),
  min_price numeric(12,2) NOT NULL CHECK (min_price >= 0),
  max_price numeric(12,2) NOT NULL CHECK (max_price >= 0),
  stock integer NOT NULL DEFAULT 0 CHECK (stock >= 0),
  product_type text NOT NULL DEFAULT 'general' CHECK (product_type IN ('general','clothing')),
  sizes jsonb NOT NULL DEFAULT '[]'::jsonb,
  colors jsonb NOT NULL DEFAULT '[]'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (min_price >= base_price),
  CHECK (max_price >= min_price),
  CHECK (starting_price >= min_price AND starting_price <= max_price)
);

CREATE INDEX IF NOT EXISTS solo_marketing_products_active_created_idx
  ON solo_marketing_products(active, created_at DESC);

CREATE TABLE IF NOT EXISTS solo_marketing_shipping_rates (
  governorate text PRIMARY KEY,
  fee numeric(12,2) NOT NULL DEFAULT 0 CHECK (fee >= 0),
  active boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO solo_marketing_shipping_rates(governorate, fee, active) VALUES
('القاهرة',0,false),('الجيزة',0,false),('الإسكندرية',0,false),('القليوبية',0,false),
('الدقهلية',0,false),('البحر الأحمر',0,false),('البحيرة',0,false),('الفيوم',0,false),
('الغربية',0,false),('الإسماعيلية',0,false),('المنوفية',0,false),('المنيا',0,false),
('الوادي الجديد',0,false),('السويس',0,false),('أسوان',0,false),('الشرقية',0,false),
('أسيوط',0,false),('بني سويف',0,false),('بورسعيد',0,false),('دمياط',0,false),
('جنوب سيناء',0,false),('كفر الشيخ',0,false),('مطروح',0,false),('الأقصر',0,false),
('قنا',0,false),('شمال سيناء',0,false),('سوهاج',0,false)
ON CONFLICT(governorate) DO NOTHING;

CREATE TABLE IF NOT EXISTS solo_marketing_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_code text NOT NULL UNIQUE,
  marketer_id text NOT NULL,
  product_id uuid REFERENCES solo_marketing_products(id) ON DELETE SET NULL,
  product_name text NOT NULL,
  buyer_full_name text NOT NULL,
  buyer_phone text NOT NULL,
  governorate text NOT NULL,
  delivery_address text NOT NULL,
  selected_size text,
  selected_color text,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  base_price numeric(12,2) NOT NULL CHECK (base_price >= 0),
  selling_price numeric(12,2) NOT NULL CHECK (selling_price >= 0),
  commission numeric(12,2) NOT NULL CHECK (commission >= 0),
  shipping_fee numeric(12,2) NOT NULL DEFAULT 0 CHECK (shipping_fee >= 0),
  total numeric(12,2) NOT NULL CHECK (total >= 0),
  status text NOT NULL DEFAULT 'طلب جديد',
  confirmed_at timestamptz,
  commission_credited_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS solo_marketing_orders_marketer_created_idx
  ON solo_marketing_orders(marketer_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS solo_marketing_orders_status_created_idx
  ON solo_marketing_orders(status, created_at DESC) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS wallet_transactions_solo_marketing_ref_uq
  ON wallet_transactions(user_id, reference)
  WHERE reference LIKE 'solo-marketing:%';

CREATE OR REPLACE FUNCTION create_solo_marketing_order(
  p_marketer_id text,
  p_product_id uuid,
  p_selling_price numeric,
  p_buyer_full_name text,
  p_buyer_phone text,
  p_governorate text,
  p_delivery_address text,
  p_selected_size text,
  p_selected_color text,
  p_order_code text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
DECLARE
  v_product solo_marketing_products%ROWTYPE;
  v_shipping numeric(12,2);
  v_commission numeric(12,2);
  v_order solo_marketing_orders%ROWTYPE;
BEGIN
  IF COALESCE(btrim(p_marketer_id),'')='' OR COALESCE(btrim(p_order_code),'')='' OR
     COALESCE(btrim(p_buyer_full_name),'')='' OR COALESCE(btrim(p_buyer_phone),'')='' OR
     COALESCE(btrim(p_governorate),'')='' OR COALESCE(btrim(p_delivery_address),'')='' THEN
    RAISE EXCEPTION 'required_fields_missing';
  END IF;

  SELECT * INTO v_product
    FROM solo_marketing_products
   WHERE id=p_product_id AND active=true
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'product_unavailable'; END IF;
  IF v_product.stock < 1 THEN RAISE EXCEPTION 'out_of_stock'; END IF;
  IF p_selling_price IS NULL OR p_selling_price < v_product.min_price OR p_selling_price > v_product.max_price THEN
    RAISE EXCEPTION 'price_out_of_range';
  END IF;

  IF v_product.product_type='clothing' THEN
    IF jsonb_array_length(COALESCE(v_product.sizes,'[]'::jsonb)) > 0 AND
       NOT (COALESCE(v_product.sizes,'[]'::jsonb) ? COALESCE(p_selected_size,'')) THEN
      RAISE EXCEPTION 'invalid_size';
    END IF;
    IF jsonb_array_length(COALESCE(v_product.colors,'[]'::jsonb)) > 0 AND
       NOT (COALESCE(v_product.colors,'[]'::jsonb) ? COALESCE(p_selected_color,'')) THEN
      RAISE EXCEPTION 'invalid_color';
    END IF;
  ELSE
    p_selected_size := NULL;
    p_selected_color := NULL;
  END IF;

  SELECT fee INTO v_shipping
    FROM solo_marketing_shipping_rates
   WHERE governorate=btrim(p_governorate) AND active=true;
  IF NOT FOUND THEN RAISE EXCEPTION 'shipping_unavailable'; END IF;

  v_commission := round(p_selling_price-v_product.base_price,2);
  IF v_commission < 0 THEN RAISE EXCEPTION 'invalid_commission'; END IF;

  UPDATE solo_marketing_products
     SET stock=stock-1, updated_at=now()
   WHERE id=v_product.id AND stock>0;

  INSERT INTO solo_marketing_orders(
    order_code,marketer_id,product_id,product_name,buyer_full_name,buyer_phone,
    governorate,delivery_address,selected_size,selected_color,quantity,
    base_price,selling_price,commission,shipping_fee,total,status
  ) VALUES (
    p_order_code,p_marketer_id,v_product.id,v_product.name,btrim(p_buyer_full_name),btrim(p_buyer_phone),
    btrim(p_governorate),btrim(p_delivery_address),NULLIF(btrim(COALESCE(p_selected_size,'')),''),
    NULLIF(btrim(COALESCE(p_selected_color,'')),''),1,v_product.base_price,p_selling_price,
    v_commission,v_shipping,round(p_selling_price+v_shipping,2),'طلب جديد'
  ) RETURNING * INTO v_order;

  RETURN jsonb_build_object(
    'id',v_order.id,'order_code',v_order.order_code,'product_name',v_order.product_name,
    'selling_price',v_order.selling_price,'commission',v_order.commission,
    'shipping_fee',v_order.shipping_fee,'total',v_order.total,'status',v_order.status,
    'created_at',v_order.created_at
  );
END;
$function$;

CREATE OR REPLACE FUNCTION confirm_solo_marketing_order(p_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
DECLARE
  v_order solo_marketing_orders%ROWTYPE;
  v_tx uuid;
  v_balance numeric(12,2);
  old_hatchable_user text;
  old_wallet_user text;
  v_credited boolean := false;
BEGIN
  SELECT * INTO v_order
    FROM solo_marketing_orders
   WHERE id=p_order_id AND deleted_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order_not_found'; END IF;

  IF v_order.commission_credited_at IS NOT NULL THEN
    SELECT balance INTO v_balance FROM wallets WHERE user_id=v_order.marketer_id;
    RETURN jsonb_build_object('ok',true,'already_confirmed',true,'credited',false,
      'commission',v_order.commission,'balance',COALESCE(v_balance,0),'order_code',v_order.order_code);
  END IF;

  old_hatchable_user := current_setting('hatchable.user_id',true);
  old_wallet_user := current_setting('together.wallet_user_id',true);
  PERFORM set_config('hatchable.user_id',v_order.marketer_id,true);
  PERFORM set_config('together.wallet_user_id',v_order.marketer_id,true);

  IF v_order.commission > 0 THEN
    INSERT INTO wallet_transactions(user_id,type,amount,reference)
    VALUES(v_order.marketer_id,'solo_marketing_commission',v_order.commission,'solo-marketing:'||v_order.order_code)
    ON CONFLICT(user_id,reference) WHERE reference LIKE 'solo-marketing:%'
    DO NOTHING
    RETURNING id INTO v_tx;

    IF v_tx IS NOT NULL THEN
      INSERT INTO wallets(user_id,balance)
      VALUES(v_order.marketer_id,v_order.commission)
      ON CONFLICT(user_id) DO UPDATE
        SET balance=wallets.balance+EXCLUDED.balance,updated_at=now();
      v_credited := true;
    END IF;
  END IF;

  UPDATE solo_marketing_orders
     SET confirmed_at=now(),commission_credited_at=now(),
         status='تم تأكيد الطلب',updated_at=now()
   WHERE id=p_order_id;

  SELECT balance INTO v_balance FROM wallets WHERE user_id=v_order.marketer_id;
  PERFORM set_config('hatchable.user_id',COALESCE(old_hatchable_user,''),true);
  PERFORM set_config('together.wallet_user_id',COALESCE(old_wallet_user,''),true);

  RETURN jsonb_build_object('ok',true,'already_confirmed',false,'credited',v_credited,
    'commission',v_order.commission,'balance',COALESCE(v_balance,0),'order_code',v_order.order_code);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('hatchable.user_id',COALESCE(old_hatchable_user,''),true);
  PERFORM set_config('together.wallet_user_id',COALESCE(old_wallet_user,''),true);
  RAISE;
END;
$function$;

CREATE OR REPLACE FUNCTION delete_solo_marketing_order(p_order_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
DECLARE
  v_order solo_marketing_orders%ROWTYPE;
BEGIN
  SELECT * INTO v_order
    FROM solo_marketing_orders
   WHERE id=p_order_id AND deleted_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  IF v_order.commission_credited_at IS NULL AND v_order.product_id IS NOT NULL THEN
    UPDATE solo_marketing_products
       SET stock=stock+v_order.quantity,updated_at=now()
     WHERE id=v_order.product_id;
  END IF;

  UPDATE solo_marketing_orders
     SET deleted_at=now(),updated_at=now()
   WHERE id=p_order_id;
  RETURN true;
END;
$function$;