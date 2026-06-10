-- Example seed: initial groups + members (Phase 1).
-- This file is NOT auto-applied. Copy to `seed.sql`, edit the emails/groups for
-- your deployment, then run:
--   wrangler d1 execute cf-mediashare-db --remote --file scripts/setup/seed.sql
-- (use --local for the local dev database).

INSERT INTO groups (id, name) VALUES
  ('family', 'Family'),
  ('friends', 'Friends');

INSERT INTO users (id, email) VALUES
  ('u_alice', 'alice@example.com'),
  ('u_bob',   'bob@example.com');

INSERT INTO memberships (user_id, group_id) VALUES
  ('u_alice', 'family'),
  ('u_alice', 'friends'),
  ('u_bob',   'family');
