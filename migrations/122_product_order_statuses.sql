UPDATE orders SET status='جارى معالجة الطلب' WHERE status IS NULL OR status='' OR status='pending';
ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'جارى معالجة الطلب';
CREATE INDEX IF NOT EXISTS orders_status_created_idx ON orders(status,created_at DESC);