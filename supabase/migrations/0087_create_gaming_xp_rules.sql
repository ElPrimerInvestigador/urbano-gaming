-- Migration: 0087_create_gaming_xp_rules
-- Persistent Metagame Phase 1.
--
-- Maps a normalized fact — (category_key, consequence_class,
-- performance_band_key) — to an XP points value. This is the ONLY
-- table Metagame policy (0090) may consult to decide "how many points
-- is this fact worth"; no Experience adapter (Predictions or any
-- future one) may query this table directly, per the canonical
-- boundary: the Experience reports facts, Metagame selects
-- consequences.
--
-- performance_band_key is null for the PARTICIPATION row (participation
-- is not banded — meaningful_participation is a plain boolean fact,
-- not a graded one) and required for every PERFORMANCE row. The check
-- constraint below makes this shape structural, not a convention.
--
-- No numerical Product value is seeded here, matching
-- progression_rule_points' own precedent of shipping schema before
-- values are decided — points is left for calibration, not invented.
-- Local tests insert explicit fixture rows.
--
-- Versioned by effective_at/superseded_at rather than in-place UPDATE:
-- a rule-value change must never reinterpret an already-awarded XP
-- event's historical meaning. Every gaming_xp_events row (0088)
-- snapshots which rule row actually fired, permanently.

create table gaming_xp_rules (
  gaming_xp_rule_id uuid primary key default gen_random_uuid(),
  category_key text not null,
  consequence_class text not null check (consequence_class in ('PARTICIPATION', 'PERFORMANCE')),
  performance_band_key text null,
  points integer not null check (points >= 0),
  effective_at timestamptz not null default now(),
  superseded_at timestamptz null,
  created_at timestamptz not null default now(),
  constraint gaming_xp_rules_performance_band_shape check (
    (consequence_class = 'PARTICIPATION' and performance_band_key is null)
    or (consequence_class = 'PERFORMANCE' and performance_band_key is not null)
  )
);

create index gaming_xp_rules_lookup_idx
  on gaming_xp_rules (category_key, consequence_class, performance_band_key, effective_at);
