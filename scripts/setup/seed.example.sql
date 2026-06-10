-- Example seed: initial groups + members (Phase 1).
-- This file is NOT auto-applied. Copy to `seed.sql`, edit the emails/groups for
-- your deployment, then run:
--   wrangler d1 execute cf-mediashare-db --remote --file scripts/setup/seed.sql
-- (use --local for the local dev database; `pnpm seed:local` applies this
-- example file as-is, which pairs with DEV_STUB_EMAIL=alice@example.com).

INSERT INTO groups (id, name) VALUES
  ('family', 'Family'),
  ('friends', 'Friends');

-- is_admin = 1 marks the operator: they can manage (delete / recaption) any
-- media item, not just their own uploads.
INSERT INTO users (id, email, is_admin) VALUES
  ('u_alice', 'alice@example.com', 1),
  ('u_bob',   'bob@example.com',   0);

INSERT INTO memberships (user_id, group_id) VALUES
  ('u_alice', 'family'),
  ('u_alice', 'friends'),
  ('u_bob',   'family');
