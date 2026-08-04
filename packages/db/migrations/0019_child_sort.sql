-- Child ordering rule for container pages: 'manual' (editor tree order,
-- the previous behavior) or a computed order — 'name' | 'createdAt' |
-- 'data.<field>', '-' prefix = descending. Read by the admin tree and by
-- delivery's default list order. Additive and idempotent.
ALTER TABLE content_item ADD COLUMN IF NOT EXISTS child_sort text NOT NULL DEFAULT 'manual';
