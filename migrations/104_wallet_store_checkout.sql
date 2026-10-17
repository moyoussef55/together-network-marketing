ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_country text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_governorate text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_address text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_phone text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method text NOT NULL DEFAULT 'wallet';
CREATE INDEX IF NOT EXISTS orders_shipping_phone_idx ON orders(shipping_phone);