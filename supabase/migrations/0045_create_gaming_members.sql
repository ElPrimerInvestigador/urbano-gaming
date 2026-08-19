-- Migration: 0045_create_gaming_members
-- URBANO Gaming Identity Foundation.
--
-- gaming_members is the persistent, cross-Session URBANO Gaming
-- identity — distinct from participants, which remains the per-Session
-- presence gameplay commands operate on (see 0046). A gaming_members
-- row's mere existence is, by construction, proof that profile
-- completion finished: this table has no nullable display_name and no
-- placeholder-name code path ever writes to it (see
-- create_gaming_member_atomically, 0047). resolveGamingMember only
-- ever reads this table; nothing else creates a row here.
--
-- Deliberately excludes everything not required for identity itself:
-- no email duplication (Supabase Auth already owns that on auth.users),
-- no Lifestyle/avatar/bio/preferences/progression/venue data, no admin
-- boolean (see gaming_admins, 0048). Every future Gaming-domain table
-- references this row by gaming_member_id, never by auth_user_id
-- directly.
--
-- auth_user_id: a real, enforced Postgres foreign key to auth.users,
-- not an unvalidated copy of the JWT subject claim. `on delete cascade`
-- and `unique` mirror the exact pattern Supabase's own internal tables
-- (auth.identities, auth.sessions, auth.mfa_factors) use for their own
-- auth.users(id) references — confirmed directly against this
-- project's local schema dump before choosing this pattern, not
-- assumed. Cascade means deleting the underlying auth user removes the
-- Gaming Member automatically; nothing else needs to reconcile that
-- separately.
--
-- RLS: left disabled here, matching every other local table in this
-- repository (see IDENTITY_FOUNDATION_IMPLEMENTATION_RECORD.md for the
-- full local/production RLS divergence — production auto-enables RLS
-- on every new public table via a live, non-migration-tracked event
-- trigger; local does not reproduce that mechanism, and this migration
-- does not attempt to repair that infrastructure gap). No policy is
-- added here, including no "defense in depth" own-row policy — this
-- table is reached only through the server's service_role client,
-- never directly from the browser.

create table gaming_members (
  gaming_member_id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users (id) on delete cascade,
  display_name text not null,
  created_at timestamptz not null default now()
);

-- Same non-empty/length floor already enforced at the application layer
-- for Participant display names (see 0004's display_name_length_check),
-- applied here as the same kind of schema-level backstop.
alter table gaming_members
  add constraint gaming_members_display_name_length_check
  check (
    char_length(btrim(display_name)) >= 1
    and char_length(btrim(display_name)) <= 40
  );
