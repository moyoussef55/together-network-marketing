CREATE TABLE IF NOT EXISTS store_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text UNIQUE NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE products ADD COLUMN IF NOT EXISTS category_id uuid REFERENCES store_categories(id) ON DELETE SET NULL;
ALTER TABLE products ADD COLUMN IF NOT EXISTS bv integer NOT NULL DEFAULT 1000 CHECK (bv >= 0);
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS bv integer NOT NULL DEFAULT 0 CHECK (bv >= 0);

ALTER TABLE network_direct_commissions ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','payable','paid'));
ALTER TABLE network_direct_commissions ADD COLUMN IF NOT EXISTS paid_at timestamptz;

CREATE INDEX IF NOT EXISTS products_category_active_idx ON products(category_id,active,created_at DESC);
CREATE INDEX IF NOT EXISTS products_active_created_idx ON products(active,created_at DESC);
CREATE INDEX IF NOT EXISTS store_categories_active_idx ON store_categories(active,created_at);
CREATE INDEX IF NOT EXISTS network_direct_commissions_status_idx ON network_direct_commissions(marketer_id,status,created_at DESC);

INSERT INTO store_categories(name,slug,active)
SELECT 'منتجات Together','together',true
WHERE NOT EXISTS (SELECT 1 FROM store_categories WHERE slug='together');