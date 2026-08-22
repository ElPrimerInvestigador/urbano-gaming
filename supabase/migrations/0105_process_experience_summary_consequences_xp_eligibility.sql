-- Migration: 0105_process_experience_summary_consequences_xp_eligibility
-- Soccer Predictions — XP Eligibility / Calibration Support Slice.
-- 0090's own process_experience_summary_consequences_atomically is
-- not edited as a file — drop-then-recreate, same precedent as every
-- prior replacement. The only behavioral change: one new early guard,
-- placed immediately after the existing TRAINING guard and shaped
-- identically to it — a non-XP-eligible Summary produces zero
-- PARTICIPATION and zero PERFORMANCE consequences, unconditionally,
-- regardless of what gaming_xp_rules/gaming_category_participation_policy
-- rows exist. One guard, read once, rather than duplicating an
-- eligibility check inside each of the two independent consequence
-- blocks below it.
--
-- This function still never inspects any Experience's own runtime
-- tables — matches.xp_eligible is not queried here; the already-copied,
-- always-present experience_summaries.xp_eligible fact (0103/0104) is
-- the only thing read, preserving the canonical boundary this
-- function's own original comment already states.
--
-- Everything else is byte-for-byte unchanged from 0090: allowance
-- accounting, Performance-after-allowance-exhaustion independence,
-- missing-policy silent no-op, and correction-aware reversal/reissue
-- logic. An eligible Summary's correction is always itself eligible
-- (xp_eligible is locked per-Match before any evidence exists, so a
-- correction of an already-evidenced Match re-reads the identical,
-- unchanging fact — see 0106/0107) — this guard never needs to
-- special-case a correction changing eligibility, because that state
-- is structurally unreachable.

drop function if exists process_experience_summary_consequences_atomically(uuid);

create function process_experience_summary_consequences_atomically(
  p_experience_summary_id uuid
)
returns table (
  gaming_xp_event_id uuid,
  consequence_class text,
  points integer,
  reverses_gaming_xp_event_id uuid,
  already_processed boolean
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_gaming_member_id uuid;
  v_category_key text;
  v_activity_classification text;
  v_occurred_at timestamptz;
  v_meaningful_participation boolean;
  v_performance_band_key text;
  v_supersedes_id uuid;
  v_xp_eligible boolean;
  v_old_meaningful_participation boolean;
  v_already_processed boolean;
  r_old_event record;
  v_policy record;
  v_rule record;
  v_gaming_day date;
  v_existing_count integer;
  v_new_event_id uuid;
begin
  select experience_summaries.gaming_member_id, experience_summaries.category_key,
         experience_summaries.activity_classification, experience_summaries.occurred_at,
         experience_summaries.meaningful_participation, experience_summaries.performance_band_key,
         experience_summaries.supersedes_experience_summary_id, experience_summaries.xp_eligible
    into v_gaming_member_id, v_category_key, v_activity_classification, v_occurred_at,
         v_meaningful_participation, v_performance_band_key, v_supersedes_id, v_xp_eligible
  from experience_summaries
  where experience_summaries.experience_summary_id = p_experience_summary_id;

  if v_gaming_member_id is null then
    raise exception 'EXPERIENCE_SUMMARY_NOT_FOUND: no experience summary exists for this id'
      using errcode = 'P0001';
  end if;

  -- Mandatory concurrency correction: lock the member row before any
  -- count/check, so every consequence-processing call for this member
  -- serializes here regardless of which Summary it came from.
  perform 1 from gaming_members where gaming_members.gaming_member_id = v_gaming_member_id for update;

  select exists(
    select 1 from gaming_xp_events where gaming_xp_events.experience_summary_id = p_experience_summary_id
  ) into v_already_processed;

  if v_already_processed then
    return query
      select gaming_xp_events.gaming_xp_event_id, gaming_xp_events.consequence_class,
             gaming_xp_events.points, gaming_xp_events.reverses_gaming_xp_event_id, true
      from gaming_xp_events
      where gaming_xp_events.experience_summary_id = p_experience_summary_id;
    return;
  end if;

  -- TRAINING carries zero XP and zero competitive-state consequence by
  -- Product definition, regardless of what facts the Experience
  -- reports (an Experience's own participation/performance facts are
  -- true statements about what happened; they do not, on their own,
  -- decide whether TRAINING activity is recognized at all — that is
  -- exactly the Experience-reports-facts / Metagame-selects-
  -- consequences boundary this function exists to enforce). No
  -- Experience adapter should have to remember to suppress this
  -- itself.
  if v_activity_classification = 'TRAINING' then
    return query select null::uuid, null::text, null::integer, null::uuid, false where false;
    return;
  end if;

  -- XP eligibility: a non-eligible Summary produces zero XP,
  -- unconditionally, regardless of any configured policy/rule — the
  -- distinct, orthogonal "curated catalog" gate research requires
  -- alongside (never instead of) Activity Classification. This is a
  -- Product-authored fact about the underlying Match, already resolved
  -- and copied onto the Summary by the reporting Experience; this
  -- function does not, and must not, decide it.
  if not v_xp_eligible then
    return query select null::uuid, null::text, null::integer, null::uuid, false where false;
    return;
  end if;

  if v_supersedes_id is not null then
    select experience_summaries.meaningful_participation into v_old_meaningful_participation
    from experience_summaries
    where experience_summaries.experience_summary_id = v_supersedes_id;

    for r_old_event in
      select gaming_xp_events.gaming_xp_event_id, gaming_xp_events.consequence_class,
             gaming_xp_events.points, gaming_xp_events.category_key, gaming_xp_events.gaming_xp_rule_id,
             gaming_xp_events.gaming_category_participation_policy_id, gaming_xp_events.gaming_day
      from gaming_xp_events
      where gaming_xp_events.experience_summary_id = v_supersedes_id
        and gaming_xp_events.points > 0
        and not exists (
          select 1 from gaming_xp_events reversal
          where reversal.reverses_gaming_xp_event_id = gaming_xp_events.gaming_xp_event_id
        )
    loop
      if r_old_event.consequence_class = 'PERFORMANCE'
         or (r_old_event.consequence_class = 'PARTICIPATION' and coalesce(v_old_meaningful_participation, false) and not v_meaningful_participation)
      then
        insert into gaming_xp_events (
          gaming_member_id, category_key, consequence_class, points, experience_summary_id,
          gaming_xp_rule_id, gaming_category_participation_policy_id, gaming_day,
          reverses_gaming_xp_event_id, idempotency_key
        )
        values (
          v_gaming_member_id, r_old_event.category_key, r_old_event.consequence_class, -r_old_event.points,
          p_experience_summary_id, r_old_event.gaming_xp_rule_id, r_old_event.gaming_category_participation_policy_id,
          r_old_event.gaming_day, r_old_event.gaming_xp_event_id,
          'reverse:' || r_old_event.gaming_xp_event_id::text
        )
        on conflict (gaming_member_id, idempotency_key) do nothing;
      end if;
    end loop;
  end if;

  -- PARTICIPATION: attempt a new award only when this fact is true AND
  -- there is not already a standing, unreversed participation award
  -- from the summary this one supersedes (an ordinary correction that
  -- leaves participation valid must not award it a second time).
  if v_meaningful_participation
     and not (
       v_supersedes_id is not null
       and coalesce(v_old_meaningful_participation, false)
       and exists (
         select 1 from gaming_xp_events
         where gaming_xp_events.experience_summary_id = v_supersedes_id
           and gaming_xp_events.consequence_class = 'PARTICIPATION'
           and gaming_xp_events.points > 0
           and not exists (
             select 1 from gaming_xp_events reversal
             where reversal.reverses_gaming_xp_event_id = gaming_xp_events.gaming_xp_event_id
           )
       )
     )
  then
    -- Missing-policy boundary correction: the absence of a configured
    -- category participation policy, or of a PARTICIPATION rule, is a
    -- valid Product state — "no applicable XP consequence" — never an
    -- invalid Experience result. Neither case may abort this function
    -- (and therefore the calling Experience's own finalize/correct
    -- transaction, since this runs as a nested call within it). Only a
    -- genuine data-integrity violation belongs behind a raised
    -- exception here; an unconfigured policy/rule is not one.
    select gaming_category_participation_policy.* into v_policy
    from gaming_category_participation_policy
    where gaming_category_participation_policy.category_key = v_category_key
      and gaming_category_participation_policy.effective_at <= v_occurred_at
      and (gaming_category_participation_policy.superseded_at is null
           or gaming_category_participation_policy.superseded_at > v_occurred_at)
    order by gaming_category_participation_policy.effective_at desc
    limit 1;

    if v_policy.gaming_category_participation_policy_id is not null then
      v_gaming_day := (v_occurred_at at time zone v_policy.gaming_day_timezone)::date;

      -- Counts only CURRENTLY EFFECTIVE participation awards — a real
      -- award later validly reversed (points > 0, but some other event's
      -- reverses_gaming_xp_event_id points back at it) must not remain
      -- permanently counted against the allowance; the slot it occupied
      -- frees up, exactly as a fresh unconsumed allowance would. Neither
      -- row is ever deleted — this is a read-time filter, not a mutation.
      select count(*) into v_existing_count
      from gaming_xp_events
      where gaming_xp_events.gaming_member_id = v_gaming_member_id
        and gaming_xp_events.category_key = v_category_key
        and gaming_xp_events.gaming_day = v_gaming_day
        and gaming_xp_events.consequence_class = 'PARTICIPATION'
        and gaming_xp_events.points > 0
        and not exists (
          select 1 from gaming_xp_events reversal
          where reversal.reverses_gaming_xp_event_id = gaming_xp_events.gaming_xp_event_id
        );

      if v_existing_count < v_policy.daily_participation_allowance then
        select gaming_xp_rules.* into v_rule
        from gaming_xp_rules
        where gaming_xp_rules.category_key = v_category_key
          and gaming_xp_rules.consequence_class = 'PARTICIPATION'
          and gaming_xp_rules.performance_band_key is null
          and gaming_xp_rules.effective_at <= v_occurred_at
          and (gaming_xp_rules.superseded_at is null or gaming_xp_rules.superseded_at > v_occurred_at)
        order by gaming_xp_rules.effective_at desc
        limit 1;

        if v_rule.gaming_xp_rule_id is not null then
          insert into gaming_xp_events (
            gaming_member_id, category_key, consequence_class, points, experience_summary_id,
            gaming_xp_rule_id, gaming_category_participation_policy_id, gaming_day, idempotency_key
          )
          values (
            v_gaming_member_id, v_category_key, 'PARTICIPATION', v_rule.points, p_experience_summary_id,
            v_rule.gaming_xp_rule_id, v_policy.gaming_category_participation_policy_id, v_gaming_day,
            p_experience_summary_id::text || ':PARTICIPATION'
          )
          on conflict (gaming_member_id, idempotency_key) do nothing;
        end if;
        -- else: no PARTICIPATION rule configured for this category as
        -- of occurred_at — no applicable consequence, no event, no error.
      end if;
      -- else: allowance exhausted for this member/category/day — no
      -- event, no error. The Summary remains valid; performance
      -- processing below is entirely unaffected.
    end if;
    -- else: no category participation policy configured as of
    -- occurred_at at all — no applicable consequence, no event, no
    -- error. Deploying this schema never requires a Product allowance
    -- number to exist.
  end if;

  -- PERFORMANCE: a fact-driven lookup only, never chosen by the caller.
  if v_performance_band_key is not null then
    select gaming_xp_rules.* into v_rule
    from gaming_xp_rules
    where gaming_xp_rules.category_key = v_category_key
      and gaming_xp_rules.consequence_class = 'PERFORMANCE'
      and gaming_xp_rules.performance_band_key = v_performance_band_key
      and gaming_xp_rules.effective_at <= v_occurred_at
      and (gaming_xp_rules.superseded_at is null or gaming_xp_rules.superseded_at > v_occurred_at)
    order by gaming_xp_rules.effective_at desc
    limit 1;

    if v_rule.gaming_xp_rule_id is not null and v_rule.points > 0 then
      -- gaming_day for a PERFORMANCE event: derived the same way as
      -- PARTICIPATION's, using the authoritative Gaming-Day timezone —
      -- PERFORMANCE is never allowance-gated, but every event still
      -- carries a real gaming_day for consistent historical reporting.
      v_gaming_day := (v_occurred_at at time zone 'America/Tegucigalpa')::date;

      insert into gaming_xp_events (
        gaming_member_id, category_key, consequence_class, points, experience_summary_id,
        gaming_xp_rule_id, gaming_category_participation_policy_id, gaming_day, idempotency_key
      )
      values (
        v_gaming_member_id, v_category_key, 'PERFORMANCE', v_rule.points, p_experience_summary_id,
        v_rule.gaming_xp_rule_id, null, v_gaming_day,
        p_experience_summary_id::text || ':PERFORMANCE'
      )
      on conflict (gaming_member_id, idempotency_key) do nothing;
    end if;
  end if;

  return query
    select gaming_xp_events.gaming_xp_event_id, gaming_xp_events.consequence_class,
           gaming_xp_events.points, gaming_xp_events.reverses_gaming_xp_event_id, false
    from gaming_xp_events
    where gaming_xp_events.experience_summary_id = p_experience_summary_id;
end;
$$;
