-- Migration: 0090_create_process_experience_summary_consequences_atomically
-- Persistent Metagame Phase 1.
--
-- The ONLY function that reads gaming_xp_rules / gaming_category_participation_policy
-- and writes gaming_xp_events. Called with nothing but an
-- experience_summary_id it already trusts (recorded by 0089 moments
-- earlier, in the same transaction) — this function never inspects
-- any Experience's own runtime tables. This is the concrete
-- implementation of the canonical boundary: the Experience reports
-- facts (into experience_summaries); Metagame policy, and only
-- Metagame policy, selects consequences.
--
-- Mandatory concurrency correction: the naive "lock/count existing
-- participation rows" design is unsafe when zero qualifying rows exist
-- yet — there is nothing to lock, so two concurrent finalizations for
-- the same Gaming Member could both observe count < N and both
-- insert, exceeding the allowance. This function instead locks the
-- gaming_members row itself FOR UPDATE first, serializing every
-- consequence-processing call for that member — the count that
-- follows is then race-free by construction, the same "lock the
-- parent, then count/insert children" pattern already proven in this
-- codebase (e.g. seat allocation under join_poker_table_atomically's
-- own row lock).
--
-- Idempotent per Summary: every event this function produces for one
-- experience_summary_id carries idempotency_key values derived from
-- that summary_id, and a repeat call for an already-processed summary
-- returns the existing rows unchanged rather than reprocessing.
--
-- Correction-aware: when the Summary's own supersedes_experience_summary_id
-- is set, this function looks at the superseded Summary's still-
-- effective (non-reversed) events. PERFORMANCE-class events are always
-- reversed and reissued against the corrected fact — mirroring
-- correct_match_result_atomically's own existing, already-proven
-- unconditional-reverse-then-reissue behavior. PARTICIPATION-class
-- events are reversed ONLY when the correction itself changes
-- meaningful_participation from true to false (an ordinary correctness
-- correction leaves participation, and its XP, standing exactly as
-- awarded) — per the explicit Product rule that ordinary losses never
-- remove Gaming XP; negative events exist only as compensating
-- reversals of a genuinely invalidated consequence, never as
-- punishment.
--
-- Allowance accounting counts only currently-EFFECTIVE PARTICIPATION
-- awards (points > 0 with no existing reversal pointing at them) for
-- the member/category/Gaming-Day — a reversed award correctly frees
-- its slot back up rather than remaining permanently counted.

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
         experience_summaries.supersedes_experience_summary_id
    into v_gaming_member_id, v_category_key, v_activity_classification, v_occurred_at,
         v_meaningful_participation, v_performance_band_key, v_supersedes_id
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
    select gaming_category_participation_policy.* into v_policy
    from gaming_category_participation_policy
    where gaming_category_participation_policy.category_key = v_category_key
      and gaming_category_participation_policy.effective_at <= v_occurred_at
      and (gaming_category_participation_policy.superseded_at is null
           or gaming_category_participation_policy.superseded_at > v_occurred_at)
    order by gaming_category_participation_policy.effective_at desc
    limit 1;

    if v_policy.gaming_category_participation_policy_id is null then
      raise exception 'NO_PARTICIPATION_POLICY_CONFIGURED: no category participation policy is effective for % at %',
        v_category_key, v_occurred_at using errcode = 'P0001';
    end if;

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

      if v_rule.gaming_xp_rule_id is null then
        raise exception 'NO_XP_RULE_CONFIGURED: no PARTICIPATION rule is effective for % at %',
          v_category_key, v_occurred_at using errcode = 'P0001';
      end if;

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
    -- else: allowance exhausted for this member/category/day — no
    -- event, no error. The Summary remains valid; performance
    -- processing below is entirely unaffected.
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
