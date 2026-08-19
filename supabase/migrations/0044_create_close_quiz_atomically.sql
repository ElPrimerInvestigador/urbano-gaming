-- Migration: 0044_create_close_quiz_atomically
-- Quiz Experience — dedicated, idempotent Close Quiz operation.
--
-- Deliberately NOT a generalization of reveal_results_atomically,
-- which continues to evaluate and reveal exactly one Interaction
-- Instance at a time, unchanged, for Trivia/Open Response/Voting.
-- Close Quiz evaluates and reveals every question Interaction Instance
-- in a Quiz Segment together, in one transaction — a genuinely
-- different shape, not a parameterization of the existing function.
--
-- Callable by either the session's host (manual early close, always
-- authorized regardless of the deadline) or any participant of this
-- session (only once the database's own clock has actually reached
-- closes_at — a participant may trigger the automatic-expiry path but
-- may never force an early close, which would let one participant
-- unilaterally lock out others still answering). Exactly one of these
-- two authorities is required; a caller token matching neither is
-- rejected outright.
--
-- Idempotent: if the Quiz window is already closed, this returns the
-- existing closed_at immediately and performs no further work — no
-- re-evaluation, no duplicate point_awards (point_awards' own
-- (session_id, idempotency_key) uniqueness would prevent double-award
-- even without this early return, but the early return also avoids
-- redundant work and redundant session_events rows on a benign
-- host-close/expiry-close race). See this migration's own pressure
-- test in the Quiz implementation record for the concurrent-close
-- test that exercises this directly.
--
-- All-or-nothing: locking the quiz_windows row up front (for update)
-- serializes concurrent close attempts for the same Quiz before either
-- reaches the evaluation step, and everything below — the closed_at
-- write, every point_award, and every Interaction Instance's
-- RESULT_REVEAL transition — commits together inside this one
-- transaction or not at all, mirroring reveal_results_atomically's own
-- same-transaction evaluate-and-reveal guarantee (0027) at Segment
-- scope instead of single-instance scope.

create function close_quiz_atomically(
  p_session_id uuid,
  p_segment_id uuid,
  p_caller_token text
)
returns table (segment_id uuid, closed_at timestamptz, already_closed boolean)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_host_token text;
  v_segment_session_id uuid;
  v_closes_at timestamptz;
  v_closed_at timestamptz;
  v_is_host boolean := false;
  v_is_participant boolean := false;
  v_closed_by text;
begin
  select sessions.host_token into v_host_token
  from sessions
  where sessions.session_id = p_session_id
  for update;

  if v_host_token is null then
    raise exception 'SESSION_NOT_FOUND: no session exists for this session_id'
      using errcode = 'P0001';
  end if;

  select segments.session_id into v_segment_session_id
  from segments
  where segments.segment_id = p_segment_id;

  if v_segment_session_id is null or v_segment_session_id <> p_session_id then
    raise exception 'QUIZ_NOT_FOUND: no active Quiz exists for this Segment'
      using errcode = 'P0001';
  end if;

  select quiz_windows.closes_at, quiz_windows.closed_at
    into v_closes_at, v_closed_at
  from quiz_windows
  where quiz_windows.segment_id = p_segment_id
  for update;

  if v_closes_at is null then
    raise exception 'QUIZ_NOT_FOUND: no active Quiz exists for this Segment'
      using errcode = 'P0001';
  end if;

  -- Idempotent short-circuit: already finalized, nothing more to do.
  if v_closed_at is not null then
    segment_id := p_segment_id;
    closed_at := v_closed_at;
    already_closed := true;
    return next;
    return;
  end if;

  v_is_host := (p_caller_token = v_host_token);

  if not v_is_host then
    select true into v_is_participant
    from participants
    where participants.session_id = p_session_id
      and participants.participant_token = p_caller_token
    limit 1;
  end if;

  if not v_is_host and not coalesce(v_is_participant, false) then
    raise exception 'QUIZ_ACCESS_DENIED: token does not authorize closing this Quiz'
      using errcode = 'P0001';
  end if;

  if v_is_host then
    v_closed_by := 'HOST';
  else
    if now() < v_closes_at then
      raise exception 'QUIZ_EXPIRY_NOT_REACHED: the Quiz deadline has not passed yet'
        using errcode = 'P0001';
    end if;
    v_closed_by := 'TIMER';
  end if;

  update quiz_windows
  set closed_at = now()
  where quiz_windows.segment_id = p_segment_id
  returning quiz_windows.closed_at into v_closed_at;

  -- Evaluate every question in this Quiz Segment together, mirroring
  -- reveal_results_atomically's own per-instance evaluation (0027) at
  -- Segment scope: for every submitted answer to any Multiple Choice
  -- Interaction Instance in this Segment whose selected option matches
  -- that question's correct_option_index, award that question's own
  -- configured points, deterministically keyed so a retried/raced call
  -- can never double-award. Unanswered questions simply have no
  -- submission row to match here — no award, no special-cased "zero"
  -- row, consistent with point_awards' existing ledger-only-records-
  -- events model.
  insert into point_awards (
    session_id, interaction_instance_id, participant_id, points, idempotency_key
  )
  select
    p_session_id,
    submissions.interaction_instance_id,
    submissions.participant_id,
    mcd.points_for_correct,
    md5('quiz-auto:' || submissions.interaction_instance_id::text || ':' || submissions.participant_id::text)::uuid
  from submissions
  join interaction_instances ii
    on ii.interaction_instance_id = submissions.interaction_instance_id
  join multiple_choice_details mcd
    on mcd.interaction_instance_id = submissions.interaction_instance_id
  where ii.segment_id = p_segment_id
    and submissions.text = mcd.correct_option_index::text
  on conflict (session_id, idempotency_key) do nothing;

  update interaction_instances
  set state = 'RESULT_REVEAL',
      updated_at = now()
  where interaction_instances.segment_id = p_segment_id
    and interaction_instances.state <> 'RESULT_REVEAL';

  insert into session_events (session_id, event_type, payload)
  values (
    p_session_id,
    'QUIZ_CLOSED',
    jsonb_build_object('segmentId', p_segment_id, 'closedBy', v_closed_by)
  );

  segment_id := p_segment_id;
  closed_at := v_closed_at;
  already_closed := false;
  return next;
end;
$$;
