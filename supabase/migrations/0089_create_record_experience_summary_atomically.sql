-- Migration: 0089_create_record_experience_summary_atomically
-- Persistent Metagame Phase 1.
--
-- The single write path for experience_summaries (0085). Any Experience
-- capable of persistent recognition calls this — directly, as a plain
-- nested function call from within its own atomic function, so summary
-- authorship happens inside the SAME transaction as the Experience's
-- own settlement, per the accepted same-transaction Phase 1 boundary.
-- This function has no awareness of any Experience's own schema; it
-- only ever receives already-normalized facts.
--
-- Idempotent on (experience_key, idempotency_key) — mirrors
-- finalize_match_result_atomically's own already_finalized precedent
-- exactly: a retried call with the same natural key returns the
-- existing row unchanged rather than erroring or duplicating.

create function record_experience_summary_atomically(
  p_gaming_member_id uuid,
  p_experience_key text,
  p_category_key text,
  p_activity_classification text,
  p_authority_tier text,
  p_occurred_at timestamptz,
  p_finalized_at timestamptz,
  p_meaningful_participation boolean,
  p_performance_band_key text,
  p_source_reference text,
  p_ruleset_version text,
  p_supersedes_experience_summary_id uuid,
  p_idempotency_key text,
  p_evidence jsonb
)
returns table (
  experience_summary_id uuid,
  already_recorded boolean
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_existing_id uuid;
  v_new_id uuid;
begin
  if p_activity_classification not in ('TRAINING', 'CASUAL', 'RANKED', 'OFFICIAL') then
    raise exception 'INVALID_ACTIVITY_CLASSIFICATION: must be one of TRAINING, CASUAL, RANKED, OFFICIAL'
      using errcode = 'P0001';
  end if;

  if p_authority_tier not in ('SYSTEM_AUTHORITATIVE', 'ADMIN_FINALIZED', 'APPROVED_ORGANIZER', 'EXTERNAL_UNVERIFIED') then
    raise exception 'INVALID_AUTHORITY_TIER: must be one of SYSTEM_AUTHORITATIVE, ADMIN_FINALIZED, APPROVED_ORGANIZER, EXTERNAL_UNVERIFIED'
      using errcode = 'P0001';
  end if;

  select experience_summaries.experience_summary_id into v_existing_id
  from experience_summaries
  where experience_summaries.experience_key = p_experience_key
    and experience_summaries.idempotency_key = p_idempotency_key;

  if v_existing_id is not null then
    return query select v_existing_id, true;
    return;
  end if;

  insert into experience_summaries (
    gaming_member_id, experience_key, category_key, activity_classification,
    authority_tier, occurred_at, finalized_at, meaningful_participation,
    performance_band_key, source_reference, ruleset_version,
    supersedes_experience_summary_id, idempotency_key, evidence
  )
  values (
    p_gaming_member_id, p_experience_key, p_category_key, p_activity_classification,
    p_authority_tier, p_occurred_at, p_finalized_at, p_meaningful_participation,
    p_performance_band_key, p_source_reference, p_ruleset_version,
    p_supersedes_experience_summary_id, p_idempotency_key, coalesce(p_evidence, '{}'::jsonb)
  )
  returning experience_summaries.experience_summary_id into v_new_id;

  return query select v_new_id, false;
end;
$$;
