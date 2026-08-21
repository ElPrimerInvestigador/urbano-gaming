-- Migration: 0095_experience_summaries_dimension_facts
-- Persistent Metagame — Finalized Experience Summary contract
-- correction. Count-only XP may remain a controlled-v1 policy;
-- count-only *finalized evidence* may not — a future Metagame policy
-- must be able to distinguish, from Summary facts alone, which
-- specific dimensions were correct, not merely how many.
--
-- correct_dimension_count / correct_dimension_keys are added here at
-- the shared, cross-Experience experience_summaries table, but
-- deliberately carry no Experience-specific vocabulary or format at
-- this layer. Only one invariant is genuinely universal regardless of
-- which Experience ever populates these — count equals array
-- cardinality, or both are absent together — and only that invariant
-- is enforced here.
--
-- Explicitly NOT enforced at this table, on purpose: that
-- performance_band_key follows Soccer Predictions' own
-- "CORRECT_<n>_OF_4" format, that correct_dimension_keys contains
-- only Predictions' own four canonical key strings, or any fixed
-- ordering of them. Baking any of that into a shared table's CHECK
-- constraint would make this generic Metagame table implicitly
-- Predictions-specific — exactly the mistake ADR-035 exists to
-- prevent, one Experience's implementation choice becoming the
-- platform's accidental definition for every Experience after it. A
-- future Poker/Trivia/Quiz Experience will have its own band-key
-- format and, plausibly, its own dimension-key vocabulary entirely.
-- Those three invariants belong to Soccer Predictions' own adapter
-- code instead — enforced by construction (the band key and the key
-- array are both derived from the same four booleans in the same code
-- path, so they cannot disagree) and locked in by tests, never by
-- this shared schema.
--
-- text[] rather than a Postgres enum array, for the identical reason:
-- an enum type would equally bake Predictions' four values into the
-- shared type system forever.
--
-- Nullable, additive: an Experience with no performance dimension at
-- all (a pure participation-only event, or any Experience that never
-- adopts this finer contract) simply never populates these, exactly
-- like performance_band_key itself already works.
--
-- Metagame consequence-processing (0090) does not read either new
-- column and is not required to change for this migration alone —
-- count-only XP policy remains fully supported unchanged.
--
-- Production holds zero experience_summaries rows (independently
-- reconfirmed immediately before this migration was authored) — no
-- backfill.

alter table experience_summaries
  add column correct_dimension_count integer null,
  add column correct_dimension_keys text[] null;

alter table experience_summaries
  add constraint experience_summaries_dimension_count_matches_keys
  check (
    (correct_dimension_count is null and correct_dimension_keys is null)
    or (
      correct_dimension_count is not null
      and correct_dimension_keys is not null
      and correct_dimension_count = cardinality(correct_dimension_keys)
    )
  );
