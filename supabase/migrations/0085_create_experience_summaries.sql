-- Migration: 0085_create_experience_summaries
-- Persistent Metagame Phase 1 (Product/Persistent_Metagame_Architecture.md, ADR-035).
--
-- The Finalized Experience Summary — the one small, Experience-authored
-- fact record that crosses the boundary from Experience runtime into
-- the persistent metagame. Every downstream consumer (the canonical
-- Gaming XP ledger, and later Category Competitive State/Achievements)
-- reads only this table, never an Experience's own runtime tables
-- (predictions/evaluations/matches, poker_hand_results, Session
-- point_awards, ...) directly.
--
-- gaming_member_id is NOT NULL by deliberate Product decision, not an
-- oversight: a summary that cannot be attached to a persistent Gaming
-- Member identity is not evidence this system needs. An Experience
-- whose activity has no linked Gaming Member (Guest Poker today) does
-- not author a summary at all — see ADR-035 / the Phase 1 readiness
-- gate for the full reasoning.
--
-- activity_classification and authority_tier reuse the exact
-- vocabulary from Product/Persistent_Metagame_Architecture.md
-- verbatim, not a local reinterpretation.
--
-- occurred_at vs finalized_at: occurred_at is when the Gaming Member's
-- own participation happened (for Soccer Predictions, the first
-- accepted Prediction's own created_at — never moved by a later
-- pre-kickoff revision); finalized_at is when the result became
-- official, which can be substantially later. Participation-day
-- attribution (0086/0088) always uses occurred_at, never finalized_at.
--
-- meaningful_participation is a normalized boolean fact, not Experience-
-- specific evidence, because Metagame policy (0090) must be able to
-- determine participation eligibility without reading Predictions'
-- own tables. What "meaningful" means is category-specific and decided
-- entirely by the Experience's own adapter code before this row is
-- written; the fact itself is universal.
--
-- performance_band_key is likewise a normalized FACT the Experience
-- reports (e.g. 'CORRECT_3_OF_4' for Soccer Predictions), never an XP
-- decision — the Experience must never encode a rule_key/points
-- decision here. Nullable: not every finalized activity has a
-- performance dimension (a pure participation-only event would leave
-- this null).
--
-- evidence stays deliberately narrow: Experience-owned debugging/
-- provenance only. It must never become the only place a fact Metagame
-- policy actually requires lives — meaningful_participation and
-- performance_band_key exist as real columns specifically so policy
-- never needs to reach into this jsonb blob to function.
--
-- source_reference is opaque (text, not a foreign key) so this table
-- never needs to know any Experience's own schema — Predictions
-- supplies its own evaluation_id as text; a future Poker/Trivia/Quiz
-- adapter supplies whatever it owns, unchanged shape.
--
-- supersedes_experience_summary_id is the correction chain, mirroring
-- evaluations' own "never mutate, always insert a new row against the
-- new Result Version" discipline exactly.
--
-- idempotency: unique(experience_key, idempotency_key) rather than a
-- single global idempotency_key, since each Experience owns its own
-- id-generation scheme and a cross-Experience collision would be an
-- avoidable, meaningless risk with no compensating benefit — the same
-- reasoning point_awards' own session-scoped idempotency_key uniqueness
-- already established in this codebase.

create table experience_summaries (
  experience_summary_id uuid primary key default gen_random_uuid(),
  gaming_member_id uuid not null references gaming_members (gaming_member_id),
  experience_key text not null,
  category_key text not null,
  activity_classification text not null
    check (activity_classification in ('TRAINING', 'CASUAL', 'RANKED', 'OFFICIAL')),
  authority_tier text not null
    check (authority_tier in ('SYSTEM_AUTHORITATIVE', 'ADMIN_FINALIZED', 'APPROVED_ORGANIZER', 'EXTERNAL_UNVERIFIED')),
  occurred_at timestamptz not null,
  finalized_at timestamptz not null,
  meaningful_participation boolean not null,
  performance_band_key text null,
  source_reference text not null,
  ruleset_version text not null,
  supersedes_experience_summary_id uuid null references experience_summaries (experience_summary_id),
  idempotency_key text not null,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (experience_key, idempotency_key)
);

create index experience_summaries_gaming_member_id_idx on experience_summaries (gaming_member_id);
create index experience_summaries_category_key_idx on experience_summaries (category_key);
create index experience_summaries_supersedes_idx on experience_summaries (supersedes_experience_summary_id);
