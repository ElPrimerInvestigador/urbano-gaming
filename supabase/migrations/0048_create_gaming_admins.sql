-- Migration: 0048_create_gaming_admins
-- URBANO Gaming Identity Foundation.
--
-- Gaming admin authorization as a plain table, not a JWT claim.
-- Reopened and pressure-tested during this phase's own seam-resolution
-- pass: an app_metadata-based claim would remain valid on an
-- already-issued access token for up to jwt_expiry seconds (3600s,
-- confirmed in this project's local config.toml) after the admin row
-- backing it was revoked, unless every sensitive check made an extra
-- Supabase Admin API round-trip — at which point the claims approach
-- loses its simplicity advantage over this table entirely. A row here
-- is checked fresh from Postgres on every sensitive command instead
-- (see lib/gaming's admin-check helper); deleting a row here takes
-- effect on the very next request, with no token-lifetime lag.
--
-- gaming_member_id is both primary key and the sole foreign key this
-- table needs: "is this Gaming Member currently an admin" is exactly
-- "does a row with this gaming_member_id exist" — no separate boolean,
-- no soft-revocation flag. granted_by is nullable (the very first
-- admin has no granting admin to reference) and on delete set null
-- (revoking or removing the granting admin must never cascade-delete
-- the admin they granted).
--
-- No admin UI, no venue roles, and no admin-gated feature exist yet in
-- this phase — this migration and its accompanying helper exist so the
-- mechanism itself can be tested end-to-end ahead of the first feature
-- that will actually depend on it.
--
-- RLS: left disabled, matching gaming_members (0045) and every other
-- local table — this table is reached only through the server's
-- service_role client. See
-- IDENTITY_FOUNDATION_IMPLEMENTATION_RECORD.md for the full local/
-- production RLS divergence.

create table gaming_admins (
  gaming_member_id uuid primary key
    references gaming_members (gaming_member_id) on delete cascade,
  granted_at timestamptz not null default now(),
  granted_by uuid null
    references gaming_members (gaming_member_id) on delete set null
);
