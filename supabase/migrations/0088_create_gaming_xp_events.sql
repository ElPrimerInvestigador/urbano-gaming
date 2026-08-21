-- Migration: 0088_create_gaming_xp_events
-- Persistent Metagame Phase 1.
--
-- The canonical, generalized Gaming XP ledger — supersedes
-- gaming_progression_events (0061) as the write target going forward.
-- 0061/0060 are NOT dropped or renamed here: they are simply left
-- deprecated and unused for a later cleanup migration, per explicit
-- instruction not to perform destructive migration without a
-- demonstrated requirement (production holds zero real rows in either
-- table, confirmed directly before this phase began).
--
-- Preserves every proven-useful property of gaming_progression_events:
-- Gaming-Member ownership, append-only rows, deterministic idempotency
-- (unique(gaming_member_id, idempotency_key)), and compensating
-- reversal via a self-referencing reverses_gaming_xp_event_id — never
-- an edit or delete of the original row.
--
-- What generalizes beyond gaming_progression_events: no Predictions-
-- specific foreign keys (match_id/evaluation_id are gone). Every event
-- references exactly one experience_summary_id — the one canonical
-- source of attribution — plus three denormalized snapshot fields
-- copied at write time for query convenience and historical
-- immutability, the same discipline points already used correctly in
-- the old table:
--   category_key       — copied from the summary, so per-category
--                         totals never require a join;
--   consequence_class   — PARTICIPATION or PERFORMANCE, copied from the
--                         gaming_xp_rule that fired, required as an
--                         explicit field per Product authority rather
--                         than inferred from rule-key naming;
--   points              — the actual amount awarded/reversed, snapshotted
--                         so a later rule-value change can never
--                         reinterpret this row.
--
-- gaming_day is the one deliberate exception to "derive, don't
-- persist" in this schema, for the same reason poker_hands.street is:
-- it is the field a concurrency-sensitive check (the daily allowance
-- count in 0090) gates on directly. Computing it once, server-side, at
-- write time from the summary's own occurred_at converted into
-- America/Tegucigalpa — never client-supplied, never recomputed
-- per-query — is what keeps the allowance check both fast and
-- impossible to fool with a client-asserted timezone.
--
-- gaming_xp_rule_id and gaming_category_participation_policy_id are
-- the historical provenance this phase explicitly requires: which
-- rule version produced this event's points, and — for PARTICIPATION
-- events only — which participation-policy version governed the
-- allowance check at the time. gaming_category_participation_policy_id
-- is null for PERFORMANCE events, which are not allowance-gated at
-- all.
--
-- Negative points exist ONLY as compensating reversals
-- (reverses_gaming_xp_event_id not null) — enforced below as a real
-- constraint, not merely a convention, so "ordinary losses never
-- subtract Gaming XP" cannot be violated by a future bug.

create table gaming_xp_events (
  gaming_xp_event_id uuid primary key default gen_random_uuid(),
  gaming_member_id uuid not null references gaming_members (gaming_member_id),
  category_key text not null,
  consequence_class text not null check (consequence_class in ('PARTICIPATION', 'PERFORMANCE')),
  points integer not null,
  experience_summary_id uuid not null references experience_summaries (experience_summary_id),
  gaming_xp_rule_id uuid not null references gaming_xp_rules (gaming_xp_rule_id),
  gaming_category_participation_policy_id uuid null references gaming_category_participation_policy (gaming_category_participation_policy_id),
  gaming_day date not null,
  reverses_gaming_xp_event_id uuid null references gaming_xp_events (gaming_xp_event_id),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (gaming_member_id, idempotency_key),
  constraint gaming_xp_events_negative_only_as_reversal check (
    points >= 0 or reverses_gaming_xp_event_id is not null
  ),
  constraint gaming_xp_events_participation_policy_shape check (
    (consequence_class = 'PARTICIPATION') or (gaming_category_participation_policy_id is null)
  )
);

create index gaming_xp_events_member_id_idx on gaming_xp_events (gaming_member_id);
create index gaming_xp_events_summary_id_idx on gaming_xp_events (experience_summary_id);
create index gaming_xp_events_reverses_idx on gaming_xp_events (reverses_gaming_xp_event_id);

-- Supports the daily-allowance count (0090): every currently-effective
-- (non-reversed, non-reversal) PARTICIPATION award for one member/
-- category/day.
create index gaming_xp_events_participation_allowance_idx
  on gaming_xp_events (gaming_member_id, category_key, gaming_day)
  where consequence_class = 'PARTICIPATION' and points > 0;
