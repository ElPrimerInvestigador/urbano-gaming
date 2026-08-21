-- Migration: 0086_create_gaming_category_participation_policy
-- Persistent Metagame Phase 1.
--
-- Governs ONLY the daily participation-XP allowance and which
-- Gaming-Day timezone authority applies — deliberately separate from
-- gaming_xp_rules (0087), which governs points, never allowance size.
-- These two policies evolve independently: a category's daily
-- allowance can change without touching what a performance band is
-- worth, and vice versa.
--
-- No numerical Product value is seeded here — daily_participation_allowance
-- is Product-authorized calibration, not architecture, and remains
-- unconfigured in this migration. Local tests insert explicit fixture
-- rows.
--
-- Versioned by effective_at/superseded_at, mirroring the same
-- effective-dated-row discipline as gaming_xp_rules (0087) rather than
-- in-place UPDATE, so a future allowance change can never reinterpret
-- a past day's already-decided eligibility. Lookups always resolve
-- "the policy version effective at the Experience Summary's own
-- occurred_at," never "whatever is current right now" — a correction
-- processed today must use the policy that governed the Gaming Member
-- when they actually played, not today's configuration.
--
-- gaming_day_timezone is included for complete historical provenance
-- (a future policy change could theoretically change which timezone
-- authority applies) even though Phase 1 has exactly one authoritative
-- value, America/Tegucigalpa, everywhere.

create table gaming_category_participation_policy (
  gaming_category_participation_policy_id uuid primary key default gen_random_uuid(),
  category_key text not null,
  daily_participation_allowance integer not null check (daily_participation_allowance > 0),
  gaming_day_timezone text not null default 'America/Tegucigalpa',
  effective_at timestamptz not null default now(),
  superseded_at timestamptz null,
  created_at timestamptz not null default now()
);

create index gaming_category_participation_policy_lookup_idx
  on gaming_category_participation_policy (category_key, effective_at);
