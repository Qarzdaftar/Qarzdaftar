-- Snapshot-only migration: 0002 already applied these columns/indexes with a
-- nullable-to-not-null backfill suitable for existing stores. Keep this no-op
-- so future drizzle-kit generate compares against 0003_snapshot.json.
SELECT 1;