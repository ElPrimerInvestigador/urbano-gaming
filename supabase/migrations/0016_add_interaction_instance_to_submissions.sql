-- Migration: 0016_add_interaction_instance_to_submissions
-- Slice 001 — Session / Interaction separation.
--
-- Submissions now belong to an Interaction Instance, not directly to a
-- session-and-prompt pair. The column is nullable rather than NOT
-- NULL: existing historical rows predate this concept and remain
-- valid without a value, consistent with this slice's additive-only
-- migration philosophy (nothing is backfilled or dropped). All new
-- submissions, going forward, always populate it.
--
-- The prior uniqueness boundary — (session_id, participant_id,
-- prompt_id) from 0009 — is left in place untouched. It is now
-- structurally redundant (each interaction instance always gets a
-- freshly inserted, therefore already-unique, prompt row — see
-- 0020), but redundant is not harmful, and dropping a working
-- constraint is unnecessary churn for this slice.
--
-- The new constraint below is the one submissions actually rely on
-- going forward: one submission per participant per interaction
-- instance.

alter table submissions
  add column if not exists interaction_instance_id uuid
    references interaction_instances(interaction_instance_id);

create unique index if not exists submissions_interaction_instance_participant_unique
  on submissions (interaction_instance_id, participant_id);
