-- scripts/snapshot-schema.sql
--
-- Source-of-truth query for refreshing schema-snapshot.json.
--
-- HOW TO USE:
--   1. Open Supabase SQL Editor for the HNC project
--   2. Paste this entire file and run it
--   3. Click the result row, copy the JSON value of the `snapshot` column
--      (the editor returns it as `[{"snapshot": "{...}"}]`)
--   4. Paste the result back to Claude in chat — Claude will run
--      `node scripts/extract-snapshot.js` to write schema-snapshot.json
--   5. Commit and push schema-snapshot.json
--
-- WHEN TO RE-RUN:
--   Every time a migration ships that adds, drops, or renames a column on
--   one of the four core tables (appointments, leads, clients, cleaners).
--   Snapshot must land on main BEFORE the code that writes the new column.
--
-- See DEVELOPMENT_GUIDE.md → "Schema enforcement workflow" for the full
-- discipline.

SELECT jsonb_pretty(jsonb_build_object(
  'generated_at', now()::text,
  'tables', jsonb_object_agg(
    table_name,
    columns_arr
  )
)) AS snapshot
FROM (
  SELECT
    table_name,
    jsonb_agg(
      jsonb_build_object(
        'column', column_name,
        'type', data_type,
        'nullable', is_nullable = 'YES',
        'default', column_default
      ) ORDER BY ordinal_position
    ) AS columns_arr
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name IN ('appointments','leads','clients','cleaners')
  GROUP BY table_name
) t;
