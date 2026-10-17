UPDATE orders SET status='pending' WHERE status='جارى معالجة الطلب';
ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'pending';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfillment_status text NOT NULL DEFAULT 'جارى معالجة الطلب';
CREATE INDEX IF NOT EXISTS orders_fulfillment_status_created_idx ON orders(fulfillment_status,created_at DESC);