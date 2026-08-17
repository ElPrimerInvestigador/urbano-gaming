import type {
  SessionRecord,
  SessionState,
  InteractionState,
  EngineType,
  VotingCandidateSource,
  VotingCandidateSummary,
  VotingResultSummary,
  SegmentTarget,
} from "../types";

export interface SessionEventRecord {
  sessionId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export interface ParticipantRecord {
  participantId: string;
  sessionId: string;
  displayName: string;
  normalizedDisplayName: string;
  participantToken: string;
  joinedAt: string;
}

export interface ParticipantJoinedEventRecord extends SessionEventRecord {
  eventType: "PARTICIPANT_JOINED";
  payload: {
    participantId: string;
    displayName: string;
  };
}

export interface LobbyLockedEventRecord extends SessionEventRecord {
  eventType: "LOBBY_LOCKED";
  payload: Record<string, never>;
}

export interface SessionCompletedEventRecord extends SessionEventRecord {
  eventType: "SESSION_COMPLETED";
  payload: Record<string, never>;
}

export interface PromptRecord {
  promptId: string;
  text: string;
}

/**
 * Slice 001 (Session / Interaction separation). One executable Open
 * Response interaction inside a session. Sessions may now run zero,
 * one, or many of these sequentially — each owns its own prompt and
 * its own PROMPT_ACTIVE / SUBMISSIONS_CLOSED / RESULT_REVEAL
 * lifecycle, independent of the session's own (now narrower)
 * lifecycle.
 *
 * Deliberately has no stored sequence number and no stored
 * state_version — see 0015's migration comment for why both were
 * cut during the accepted design's stress test. Ordering and
 * "current" are both derived from createdAt, never stored.
 *
 * Slice 003 (Second Interaction Engine): engineType is the single
 * source of truth for which engine produced this interaction —
 * 'OPEN_RESPONSE' for every row that predates this slice.
 *
 * Slice 008 (Segment / Turn grouping): segmentId is the Interaction
 * Instance's Segment membership — every row now belongs to exactly one
 * Segment, including every pre-Slice-008 row (each backfilled into its
 * own one-Interaction-Instance Segment; see 0036's migration comment).
 * Retained alongside sessionId rather than replacing it — every
 * existing query filtering by sessionId keeps working unchanged; the
 * composite (session_id, segment_id) foreign key (0036) is what
 * prevents the two from ever disagreeing.
 */
export interface InteractionInstanceRecord {
  interactionInstanceId: string;
  sessionId: string;
  segmentId: string;
  promptId: string;
  state: InteractionState;
  engineType: EngineType;
  createdAt: string;
  updatedAt: string;
}

/**
 * Slice 008 (Segment / Turn grouping). A Segment groups one or more
 * Interaction Instances under one stable, member-facing Turn identity.
 * segmentOrdinal IS that Turn number — a durable value allocated once,
 * atomically, inside start_session_atomically's existing per-session
 * row lock (see that migration's comment for why this is safe without
 * an advisory lock or a separate counter table), not a derived count or
 * an artifact of createdAt ordering. createdAt is audit/history
 * information only; it plays no role in Turn identity.
 *
 * Deliberately has no stored lifecycle/state column — whether a Segment
 * is still current, still accepting another Interaction Instance, or
 * has been superseded is entirely derived from its own most-recent
 * Interaction Instance's state and from whether a newer Segment exists,
 * mirroring InteractionInstanceRecord's own "derive, don't persist"
 * precedent one level up.
 */
export interface SegmentRecord {
  segmentId: string;
  sessionId: string;
  segmentOrdinal: number;
  createdAt: string;
}

/**
 * Slice 003. The Multiple Choice engine's own data for one interaction
 * instance — a 1:1 extension, not a merge into InteractionInstanceRecord
 * itself (see 0024's migration comment for why). correctOptionIndex is
 * private state: known to the repository from creation, but the
 * domain layer (GET_SESSION) is exclusively responsible for
 * withholding it from any caller until the interaction reaches
 * RESULT_REVEAL.
 */
export interface MultipleChoiceDetailsRecord {
  interactionInstanceId: string;
  options: string[];
  correctOptionIndex: number;
  pointsForCorrect: number;
}

/**
 * Slice 007 (Voting Engine). A Voting Candidate — the output of
 * Candidate Resolution, Voting-owned and immutable once created,
 * regardless of which source (HOST_AUTHORED or SUBMISSION) produced
 * it. Provenance (which source produced a given Candidate) is
 * deliberately not a column here — it is recorded only in the
 * INTERACTION_STARTED event's payload, since nothing in Voting's own
 * tallying or reveal logic needs to read it back. If reveal-time
 * attribution ("submitted by Alex") becomes a real product need later,
 * promoting it to a column is a small additive migration, not a
 * redesign.
 */
export interface VotingCandidateRecord {
  candidateId: string;
  interactionInstanceId: string;
  ordinal: number;
  label: string;
  createdAt: string;
}

/**
 * Slice 007. One participant's current vote in one Voting interaction
 * instance. One row per (interactionInstanceId, participantId) —
 * revisable via upsert while the interaction is PROMPT_ACTIVE
 * (mirrors SubmissionRecord's own last-write-wins shape exactly),
 * immutable once the interaction leaves PROMPT_ACTIVE.
 */
export interface VoteRecord {
  voteId: string;
  interactionInstanceId: string;
  participantId: string;
  candidateId: string;
  createdAt: string;
  updatedAt: string;
}

export interface VoteCastEventRecord extends SessionEventRecord {
  eventType: "VOTE_CAST";
  payload: {
    participantId: string;
    interactionInstanceId: string;
    candidateId: string;
  };
}

/**
 * Slice 007. Derives each Candidate's vote count and standard
 * competition rank from raw, already-immutable vote data — the single
 * shared computation both InMemorySessionRepository and
 * SupabaseSessionRepository call from their own
 * getVotingResultsForInteractionInstance, so ranking semantics (tied
 * candidates share a rank; the next distinct count skips ranks by the
 * number tied) can never drift between the two implementations.
 * Deliberately not persisted anywhere — see VotingResultSummary's
 * comment in types.ts for why this mirrors Multiple Choice's own
 * derived-not-stored `correctness`.
 */
export function computeVotingResults(
  candidates: VotingCandidateRecord[],
  votes: VoteRecord[]
): VotingResultSummary[] {
  const countByCandidateId = new Map<string, number>();
  for (const candidate of candidates) {
    countByCandidateId.set(candidate.candidateId, 0);
  }
  for (const vote of votes) {
    countByCandidateId.set(
      vote.candidateId,
      (countByCandidateId.get(vote.candidateId) ?? 0) + 1
    );
  }

  const sorted = [...candidates].sort(
    (a, b) =>
      (countByCandidateId.get(b.candidateId) ?? 0) -
      (countByCandidateId.get(a.candidateId) ?? 0)
  );

  const results: VotingResultSummary[] = [];
  let previousCount: number | null = null;
  let previousRank = 0;
  sorted.forEach((candidate, index) => {
    const voteCount = countByCandidateId.get(candidate.candidateId) ?? 0;
    const rank = voteCount === previousCount ? previousRank : index + 1;
    previousCount = voteCount;
    previousRank = rank;
    results.push({
      candidateId: candidate.candidateId,
      label: candidate.label,
      voteCount,
      rank,
    });
  });

  return results;
}

/**
 * Slice 003. One question in a session's pre-authored Multiple Choice
 * queue. consumedAt is null until a START_SESSION call turns it into a
 * real interaction instance, after which it is permanent history —
 * never deleted or reused.
 */
export interface PreparedQuestionRecord {
  preparedQuestionId: string;
  sessionId: string;
  ordinal: number;
  promptText: string;
  options: string[];
  correctOptionIndex: number;
  pointsForCorrect: number;
  consumedAt: string | null;
  createdAt: string;
}

export interface InteractionStartedEventRecord extends SessionEventRecord {
  eventType: "INTERACTION_STARTED";
  payload: {
    interactionInstanceId: string;
    promptId: string;
  };
}

export interface SubmissionRecord {
  submissionId: string;
  sessionId: string;
  /**
   * Slice 001: the authoritative scope a submission belongs to.
   * promptId is retained alongside it as harmless denormalization
   * (see 0016's migration comment) rather than removed.
   */
  interactionInstanceId: string;
  participantId: string;
  promptId: string;
  text: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResponseSubmittedEventRecord extends SessionEventRecord {
  eventType: "RESPONSE_SUBMITTED";
  payload: {
    participantId: string;
    interactionInstanceId: string;
    promptId: string;
  };
}

export interface SubmissionsClosedEventRecord extends SessionEventRecord {
  eventType: "SUBMISSIONS_CLOSED";
  payload: Record<string, never>;
}

export interface ResultsRevealedEventRecord extends SessionEventRecord {
  eventType: "RESULTS_REVEALED";
  payload: Record<string, never>;
}

/**
 * Slice 002 (Scored Multi-Round Experience). One independent scoring
 * event: the host awarding a participant a positive number of points
 * for a specific, currently-revealed interaction instance. Immutable —
 * there is no update-in-place; every row is permanent from the moment
 * it is written. Deliberately has no uniqueness constraint on
 * (interactionInstanceId, participantId): a future experience may
 * legitimately produce more than one independent scoring event for the
 * same participant in the same interaction, and this generic ledger
 * should not encode a business rule that belongs to the experience,
 * not to Shared Game State.
 */
export interface PointAwardRecord {
  pointAwardId: string;
  sessionId: string;
  interactionInstanceId: string;
  participantId: string;
  points: number;
  createdAt: string;
}

export interface PointsAwardedEventRecord extends SessionEventRecord {
  eventType: "POINTS_AWARDED";
  payload: {
    pointAwardId: string;
    interactionInstanceId: string;
    participantId: string;
    points: number;
  };
}

/**
 * Repository interface for Session Engine persistence.
 *
 * The repository exposes conceptual persistence operations rather than
 * individual database writes. This ensures callers cannot accidentally
 * persist an aggregate without its required event.
 */
export interface SessionRepository {
  /**
   * Persist a new session and its initial event as one atomic operation.
   *
   * Implementations must:
   * - commit both records or neither record;
   * - enforce active room-code uniqueness;
   * - throw RoomCodeCollisionError only when room_code collides;
   * - when record.predecessorSessionId is non-null, persist it verbatim
   *   (this method does not itself verify the predecessor exists or is
   *   SESSION_COMPLETE — that is CREATE_SUCCESSOR_SESSION's
   *   responsibility, since it is permanently true once checked and
   *   never re-verified for the same reason completeSession never
   *   needs to guard against a session un-completing) and throw
   *   PredecessorAlreadyHasSuccessorError only when
   *   predecessor_session_id collides with an existing session.
   */
  createSession(
    record: SessionRecord,
    initialEvent: SessionEventRecord
  ): Promise<void>;

  /**
   * Persist a participant and its PARTICIPANT_JOINED event atomically.
   *
   * Implementations must:
   * - commit both records or neither record;
   * - enforce session-scoped normalized display-name uniqueness;
   * - translate only the display-name uniqueness violation into the
   *   corresponding domain error.
   */
  joinParticipant(
    record: ParticipantRecord,
    joinedEvent: ParticipantJoinedEventRecord
  ): Promise<void>;

  /**
   * Resolve a room code to its active (non-SESSION_COMPLETE) session.
   * Required by JOIN_SESSION to validate the target session exists and
   * is joinable before persisting a participant.
   */
  getActiveSessionByRoomCode(roomCode: string): Promise<SessionRecord | null>;

  /** Used by tests and validation to confirm a session round-trips. */
  getSessionById(sessionId: string): Promise<SessionRecord | null>;

  /**
   * Session Continuity slice. Resolve the (at most one) session whose
   * predecessorSessionId equals the given session id — i.e. "does this
   * session have a successor, and if so, which one." Used by
   * CREATE_SUCCESSOR_SESSION as a fast-path check before attempting to
   * create a second successor (the authoritative guard is still
   * sessions_predecessor_session_id_unique, per 0028 — this is a
   * clean-error convenience, not the sole enforcement), and by
   * GET_SESSION to populate successorSessionId/successorRoomCode once
   * a session reaches SESSION_COMPLETE. Returns null if no session
   * names this one as its predecessor.
   */
  getSuccessorSessionByPredecessorId(
    predecessorSessionId: string
  ): Promise<SessionRecord | null>;

  /**
   * Atomically re-verify the supplied host token and that the session is
   * LOBBY_OPEN, then transition it to LOBBY_LOCKED, increment
   * state_version, and persist the LOBBY_LOCKED event — as one atomic
   * operation, mirroring joinParticipant's authoritative re-check.
   *
   * Implementations must:
   * - commit the state transition and its event, or neither;
   * - re-verify the host token and session state inside the atomic
   *   operation itself, not merely trust an earlier caller-side check;
   * - throw SessionNotFoundError only when no session exists for the id;
   * - throw HostTokenMismatchError only on a host-token mismatch;
   * - throw LobbyNotOpenError only when the session is not LOBBY_OPEN;
   * - return the authoritative post-transition state and state_version.
   */
  lockLobby(
    sessionId: string,
    hostToken: string,
    event: LobbyLockedEventRecord
  ): Promise<{ state: SessionState; stateVersion: number }>;

  /**
   * List all participants for a session, ordered by joinedAt ascending.
   * Not filtered by session state — GET_SESSION must be able to read a
   * session's participant list regardless of its current state.
   *
   * Tie-break contract: if multiple participants share the same
   * joinedAt timestamp, their relative order is intentionally
   * unspecified and must not be relied upon by consumers. The
   * guarantee implementations must uphold is determinism — repeated
   * calls against the same underlying data return the same order every
   * time. How a given implementation achieves that (a secondary sort
   * key, an incidental property of its storage model, or anything
   * else) is an implementation detail, not part of this contract.
   */
  getParticipantsForSession(sessionId: string): Promise<ParticipantRecord[]>;

  /**
   * Atomically re-verify the supplied host token and that the session is
   * not already SESSION_COMPLETE, then transition it to SESSION_COMPLETE,
   * increment state_version, and persist the SESSION_COMPLETED event —
   * as one atomic operation, mirroring lockLobby's authoritative
   * re-check.
   *
   * Per Interpretation 2 (administrative termination): this is callable
   * from any state except SESSION_COMPLETE itself — there is no single
   * required source state the way LOCK_LOBBY requires LOBBY_OPEN. This
   * remains true unchanged by Slice 001: completing while an
   * interaction instance is still PROMPT_ACTIVE (or any other
   * interaction state) is explicitly supported — that interaction
   * instance simply stays at whatever state it was in, as history.
   *
   * Implementations must:
   * - commit the state transition and its event, or neither;
   * - re-verify the host token and session state inside the atomic
   *   operation itself, not merely trust an earlier caller-side check;
   * - throw SessionNotFoundError only when no session exists for the id;
   * - throw HostTokenMismatchError only on a host-token mismatch;
   * - throw SessionAlreadyCompleteError only when the session is already
   *   SESSION_COMPLETE;
   * - return the authoritative post-transition state and state_version.
   */
  completeSession(
    sessionId: string,
    hostToken: string,
    event: SessionCompletedEventRecord
  ): Promise<{ state: SessionState; stateVersion: number }>;

  /**
   * Look up a single prompt by id. Returns null if it doesn't exist.
   * Used by GET_SESSION to hydrate the current interaction instance's
   * prompt.
   */
  getPromptById(promptId: string): Promise<PromptRecord | null>;

  /**
   * Slice 001: list every interaction instance for a session, ordered
   * by createdAt ascending. Callers derive "the current interaction"
   * as the last element (or null if the array is empty — no
   * interaction has been started yet) and "interactionNumber" as the
   * array's length. Not filtered by state — GET_SESSION must be able
   * to read this regardless of session state.
   *
   * Deliberately returns the full list rather than exposing separate
   * "current" and "count" methods: one query covers both needs (see
   * the accepted Slice 001 design's stress test on avoiding a stored
   * sequence number or a stored "current" pointer).
   */
  getInteractionInstancesForSession(
    sessionId: string
  ): Promise<InteractionInstanceRecord[]>;

  /**
   * Slice 008 (Segment / Turn grouping). List every Segment for a
   * session, ordered by segmentOrdinal ascending. Callers derive "the
   * current Segment" as the last element (or null if the array is
   * empty — no Segment has ever been created). Mirrors
   * getInteractionInstancesForSession's exact division of
   * responsibility: one query, no separate "current"/"count" methods.
   */
  getSegmentsForSession(sessionId: string): Promise<SegmentRecord[]>;

  /**
   * Slice 001. Atomically re-verify the supplied host token and that
   * the session is LOBBY_LOCKED, re-verify that the session's current
   * interaction instance (if any) is at RESULT_REVEAL, insert a new
   * prompt from the supplied text, create a new interaction instance
   * referencing it in PROMPT_ACTIVE, and persist an INTERACTION_STARTED
   * event — as one atomic operation.
   *
   * Re-invocable: unlike the pre-Slice-001 START_SESSION, this may be
   * called once per interaction, any number of times, for the same
   * session — not once per session's entire lifetime. The session's
   * own state and state_version are never touched by this call.
   *
   * Implementations must:
   * - commit the prompt insert, the interaction instance insert, and
   *   the event, or none of them;
   * - re-verify the host token and session state inside the atomic
   *   operation itself, not merely trust an earlier caller-side check;
   * - re-verify the current interaction instance's state (if one
   *   exists) inside the same atomic operation, closing the race
   *   window between two concurrent start attempts;
   * - throw SessionNotFoundError only when no session exists for the id;
   * - throw HostTokenMismatchError only on a host-token mismatch;
   * - throw LobbyNotLockedError only when the session is not
   *   LOBBY_LOCKED;
   * - throw PreviousInteractionNotRevealedError only when a current
   *   interaction instance exists and is not at RESULT_REVEAL;
   * - throw EmptyPromptTextError / PromptTextTooLongError only for the
   *   corresponding validation failure;
   * - return the newly created interaction instance's id, prompt id,
   *   and state.
   *
   * Slice 003 (Second Interaction Engine): gains an optional
   * preparedQuestionId. When supplied, promptText is ignored and the
   * implementation must instead atomically: verify the prepared
   * question exists, belongs to this session, and is not already
   * consumed; create the interaction instance as 'MULTIPLE_CHOICE';
   * create its multiple_choice_details row from the prepared
   * question's options/correctOptionIndex/pointsForCorrect; and mark
   * the prepared question consumed — all inside the same atomic
   * operation as every other check here. When omitted, behavior is
   * byte-for-byte the existing Open Response path. Deliberately
   * explicit rather than an implicit "use the next unconsumed prepared
   * question" fallback, so the request's meaning never depends on
   * hidden repository state.
   *
   * Implementations must additionally:
   * - throw PreparedQuestionNotFoundError only when preparedQuestionId
   *   does not identify a prepared question belonging to this session;
   * - throw PreparedQuestionAlreadyConsumedError only when it has
   *   already been consumed;
   * - return engineType alongside the existing fields.
   *
   * Slice 007 (Voting Engine): gains an optional votingCandidateSource,
   * mutually exclusive with preparedQuestionId (the domain layer
   * enforces this before calling; this method re-enforces it
   * authoritatively, same discipline as every other mutual-exclusivity
   * rule in this method). When supplied, promptText IS still required
   * (unlike the prepared-question path) — Voting always needs host-framed
   * text ("Vote for your favorite!"), since neither candidate source
   * provides one. Candidate Resolution happens here, inside this same
   * atomic operation, for the same reason prepared-question consumption
   * does: this is where the repository already resolves external
   * content into a new Interaction Instance, and no separate
   * orchestration layer exists in this codebase.
   *
   * - type "HOST_AUTHORED": validate candidates has at least two
   *   distinct, non-empty (post-trim) entries — mirrors
   *   validateAndTrimOptions's floor — then insert each as a
   *   Voting-owned Candidate snapshot, ordinal-ordered as supplied.
   * - type "SUBMISSION": re-verify sourceInteractionInstanceId belongs
   *   to this session, is engineType OPEN_RESPONSE, is state
   *   RESULT_REVEAL, and has at least one submission; then copy each
   *   submission's text into a new, Voting-owned Candidate snapshot.
   *   The source interaction instance itself is never modified.
   *
   * Implementations must additionally:
   * - throw InvalidVotingCandidatesError only for the HOST_AUTHORED
   *   candidate-count/emptiness failure;
   * - throw VotingSourceInteractionNotFoundError only when
   *   sourceInteractionInstanceId does not identify an interaction
   *   instance belonging to this session;
   * - throw VotingSourceInteractionNotEligibleError only when that
   *   interaction instance exists but is not OPEN_RESPONSE, not
   *   RESULT_REVEAL, or has zero submissions.
   *
   * Slice 008 (Segment / Turn grouping): gains an optional segmentTarget,
   * defaulting to "NEW_SEGMENT" when omitted — every pre-Slice-008 call
   * site keeps working unchanged. "NEW_SEGMENT" allocates the next
   * segmentOrdinal for this session (COALESCE(MAX(segment_ordinal), 0) + 1,
   * computed only after the session-row lock this method already holds
   * — see 0037's migration comment for why that lock is what makes this
   * safe without an advisory lock or a separate counter table) and
   * creates a new Segment row before creating the Interaction Instance.
   * "CURRENT_SEGMENT" creates no new Segment: it reuses the session's
   * existing current Segment's id and ordinal, attaching only a new
   * Interaction Instance to it — this is the mechanism behind the Best
   * Joke proving case (Open Response, then Voting, same Turn). Every
   * pre-existing precondition (previous interaction instance, if any,
   * must be RESULT_REVEAL) applies identically to both targets.
   *
   * Implementations must additionally:
   * - throw NoCurrentSegmentToContinueError only when segmentTarget is
   *   "CURRENT_SEGMENT" and no Interaction Instance (and therefore no
   *   Segment) has ever been created for this session;
   * - return segmentNumber (the resolved Segment's segmentOrdinal)
   *   alongside the existing fields.
   */
  startSession(
    sessionId: string,
    hostToken: string,
    promptText: string,
    preparedQuestionId?: string | null,
    votingCandidateSource?: VotingCandidateSource | null,
    segmentTarget?: SegmentTarget
  ): Promise<{
    interactionInstanceId: string;
    promptId: string;
    state: InteractionState;
    engineType: EngineType;
    segmentNumber: number;
  }>;

  /**
   * Atomically re-verify that the supplied participant token belongs to
   * the given participant of this session, that the session is
   * LOBBY_LOCKED, and that the session's current interaction instance
   * is PROMPT_ACTIVE, then upsert the participant's response to that
   * interaction instance (one submission per participant per
   * interaction instance — a second call replaces the first, "last
   * write wins") and persist a RESPONSE_SUBMITTED event.
   *
   * "Last write wins" is an explicit MVP implementation decision, not a
   * permanent gameplay rule — see SubmitResponseResult.
   *
   * Like startSession, this method does not take an event argument: the
   * event payload depends on which interaction instance is current,
   * which must be re-read authoritatively inside this same atomic
   * operation (not trusted from an earlier domain-layer read), so the
   * payload is built here, not by the caller.
   *
   * Implementations must:
   * - commit the submission and its event, or neither;
   * - re-verify the participant token and session state inside the
   *   atomic operation itself, not merely trust an earlier caller-side
   *   check;
   * - re-resolve the current interaction instance inside the same
   *   atomic operation;
   * - throw SessionNotFoundError only when no session exists for the id;
   * - throw SessionAccessDeniedError only when the token does not match
   *   the given participant of this session;
   * - throw PromptNotActiveError only when the session is not
   *   LOBBY_LOCKED, or no interaction instance exists, or the current
   *   one is not PROMPT_ACTIVE;
   * - throw EmptyResponseError / ResponseTooLongError only for the
   *   corresponding validation failure;
   * - return the resulting submissionId, the interaction instance's id
   *   and promptId, and updatedAt.
   */
  submitResponse(
    sessionId: string,
    participantId: string,
    participantToken: string,
    text: string
  ): Promise<{
    submissionId: string;
    interactionInstanceId: string;
    promptId: string;
    updatedAt: string;
  }>;

  /**
   * Slice 001: list all submissions for one interaction instance. Not
   * filtered by state — GET_SESSION's own state-based visibility rule
   * (submissions only surfaced once RESULT_REVEAL) is applied by the
   * domain layer, not this method.
   */
  getSubmissionsForInteractionInstance(
    interactionInstanceId: string
  ): Promise<SubmissionRecord[]>;

  /**
   * Atomically re-verify the supplied host token, that the session is
   * LOBBY_LOCKED, and that the session's current interaction instance
   * is PROMPT_ACTIVE, then transition that interaction instance to
   * SUBMISSIONS_CLOSED and persist the SUBMISSIONS_CLOSED event — as
   * one atomic operation, mirroring lockLobby's authoritative re-check.
   *
   * Implementations must:
   * - commit the state transition and its event, or neither;
   * - re-verify the host token and session state inside the atomic
   *   operation itself;
   * - re-resolve the current interaction instance inside the same
   *   atomic operation;
   * - throw SessionNotFoundError only when no session exists for the id;
   * - throw HostTokenMismatchError only on a host-token mismatch;
   * - throw PromptNotActiveError only when the session is not
   *   LOBBY_LOCKED, or no interaction instance exists, or the current
   *   one is not PROMPT_ACTIVE;
   * - return the interaction instance's id and its post-transition
   *   state.
   */
  closeSubmissions(
    sessionId: string,
    hostToken: string,
    event: SubmissionsClosedEventRecord
  ): Promise<{ interactionInstanceId: string; state: InteractionState }>;

  /**
   * Atomically re-verify the supplied host token, that the session is
   * LOBBY_LOCKED, and that the session's current interaction instance
   * is SUBMISSIONS_CLOSED, then transition that interaction instance to
   * RESULT_REVEAL and persist the RESULTS_REVEALED event — as one
   * atomic operation.
   *
   * Implementations must:
   * - commit the state transition and its event, or neither;
   * - re-verify the host token and session state inside the atomic
   *   operation itself;
   * - re-resolve the current interaction instance inside the same
   *   atomic operation;
   * - throw SessionNotFoundError only when no session exists for the id;
   * - throw HostTokenMismatchError only on a host-token mismatch;
   * - throw SubmissionsNotClosedError only when the session is not
   *   LOBBY_LOCKED, or no interaction instance exists, or the current
   *   one is not SUBMISSIONS_CLOSED;
   * - return the interaction instance's id and its post-transition
   *   state.
   */
  revealResults(
    sessionId: string,
    hostToken: string,
    event: ResultsRevealedEventRecord
  ): Promise<{ interactionInstanceId: string; state: InteractionState }>;

  /**
   * Slice 002. Idempotency-first: if a point_award already exists for
   * this (sessionId, idempotencyKey) pair, return it immediately — no
   * other validation runs, even if the session has since progressed to
   * a later interaction or completed. Only when the key is genuinely
   * new does the implementation validate host token, session state
   * (LOBBY_LOCKED), that interactionInstanceId is both the session's
   * current interaction and at RESULT_REVEAL, that participantId
   * belongs to the session, and that points is a positive integer —
   * then insert one new, permanent point_award row and persist a
   * POINTS_AWARDED event.
   *
   * No update-in-place: a second call with a different idempotencyKey,
   * even for the same participant and interaction, creates a second,
   * independent row. This is deliberate — the ledger does not enforce
   * "one award per participant per interaction."
   *
   * Implementations must:
   * - resolve idempotencyKey (scoped to sessionId) before any other
   *   check, and skip all other validation on a match;
   * - commit the new row and its event atomically, or neither;
   * - guard against a concurrent request racing on the same
   *   (sessionId, idempotencyKey) pair by returning the winner's result
   *   rather than erroring;
   * - throw SessionNotFoundError only when no session exists for the id;
   * - throw HostTokenMismatchError only on a host-token mismatch;
   * - throw LobbyNotLockedError only when the session is not
   *   LOBBY_LOCKED;
   * - throw InteractionInstanceNotEligibleError only when
   *   interactionInstanceId is not the session's current interaction,
   *   or that interaction is not at RESULT_REVEAL;
   * - throw ParticipantNotInSessionError only when participantId does
   *   not belong to this session;
   * - throw InvalidPointsError only when points is not a positive
   *   integer within the accepted bound;
   * - return the resulting (or pre-existing) point award record.
   */
  awardPoints(
    sessionId: string,
    hostToken: string,
    interactionInstanceId: string,
    participantId: string,
    points: number,
    idempotencyKey: string
  ): Promise<PointAwardRecord>;

  /**
   * Slice 002: list every point award for a session. Used by
   * GET_SESSION to derive per-participant cumulative standings by
   * summation — never filtered or pre-aggregated here, since the
   * summation itself is the domain layer's responsibility.
   */
  getPointAwardsForSession(sessionId: string): Promise<PointAwardRecord[]>;

  /**
   * Slice 003 (Second Interaction Engine). Persist a batch of
   * pre-authored Multiple Choice questions for a session, assigning
   * each the next sequential ordinal after whatever already exists for
   * this session. Host-token verification and validation of each
   * question's shape (non-empty prompt text, at least two distinct
   * non-empty options, correctOptionIndex within bounds, points a
   * positive integer within the accepted bound) are the domain layer's
   * responsibility (see prepareQuestions.ts) — this method persists
   * already-validated rows.
   *
   * No atomic re-check of host token or session state is required here
   * the way write commands elsewhere in this interface require one:
   * authoring a prepared question has no concurrent invariant to
   * protect (no state transition, no uniqueness other than the
   * ordinal this method itself assigns), unlike lockLobby or
   * startSession, which race against concurrent calls changing the
   * same state.
   */
  createPreparedQuestions(
    sessionId: string,
    questions: Array<{
      promptText: string;
      options: string[];
      correctOptionIndex: number;
      pointsForCorrect: number;
    }>
  ): Promise<PreparedQuestionRecord[]>;

  /**
   * Slice 003. List every prepared question for a session, ordered by
   * ordinal ascending — both consumed and unconsumed. GET_SESSION
   * applies its own host-only visibility rule on top of this; this
   * method itself performs no filtering by caller role.
   */
  getPreparedQuestionsForSession(
    sessionId: string
  ): Promise<PreparedQuestionRecord[]>;

  /**
   * Slice 003. Look up the Multiple Choice engine's own data for one
   * interaction instance. Returns null for an Open Response
   * interaction (or any interaction instance id with no matching row).
   * Used by SUBMIT_RESPONSE (engine-aware validation) and GET_SESSION
   * (resolving options, reveal-gating correctOptionIndex, mapping
   * submitted option indices to their label text).
   */
  getMultipleChoiceDetailsForInteraction(
    interactionInstanceId: string
  ): Promise<MultipleChoiceDetailsRecord | null>;

  /**
   * Slice 007 (Voting Engine). List every Candidate for one Voting
   * interaction instance, ordinal-ordered. Not reveal-gated — Candidates
   * must be visible before voting can happen at all, mirroring
   * MULTIPLE_CHOICE's `options`. Returns an empty array for a
   * non-Voting interaction instance (or any id with no matching rows).
   */
  getVotingCandidatesForInteraction(
    interactionInstanceId: string
  ): Promise<VotingCandidateRecord[]>;

  /**
   * Slice 007. List every vote for one Voting interaction instance —
   * one row per participant who has voted, per VoteRecord's own
   * uniqueness. Used both for progress counts (pre-reveal) and, joined
   * with getVotingCandidatesForInteraction via computeVotingResults,
   * for derived results (post-reveal). Not filtered by state — visibility
   * rules are the domain layer's (GET_SESSION's) responsibility, not
   * this method's, mirroring getSubmissionsForInteractionInstance's
   * identical division of responsibility.
   */
  getVotesForInteractionInstance(
    interactionInstanceId: string
  ): Promise<VoteRecord[]>;

  /**
   * Slice 007. The single repository path for deriving Voting's
   * `placement` Outcome — candidate identity, label, vote count, and
   * standard-competition rank, computed live from immutable vote data
   * via computeVotingResults. Never persisted; see that function's
   * comment. GET_SESSION calls this only once the interaction has
   * reached RESULT_REVEAL — this method itself performs no
   * reveal-gating, the same division of responsibility used everywhere
   * else in this interface.
   */
  getVotingResultsForInteractionInstance(
    interactionInstanceId: string
  ): Promise<VotingResultSummary[]>;

  /**
   * Slice 007. CAST_VOTE's repository operation. Atomically re-verifies
   * the supplied participant token belongs to the given participant of
   * this session, that the session is LOBBY_LOCKED, that the session's
   * current interaction instance is PROMPT_ACTIVE and engineType
   * VOTING, and that candidateId identifies a Candidate belonging to
   * that interaction instance, then upserts the participant's vote
   * (one vote per participant per interaction instance — a second call
   * replaces the first, "last write wins," mirroring submitResponse's
   * identical MVP decision) and persists a VOTE_CAST event.
   *
   * Implementations must:
   * - commit the vote and its event, or neither;
   * - re-verify the participant token and session/interaction state
   *   inside the atomic operation itself, not merely trust an earlier
   *   caller-side check;
   * - throw SessionNotFoundError only when no session exists for the id;
   * - throw SessionAccessDeniedError only when the token does not match
   *   the given participant of this session;
   * - throw PromptNotActiveError only when the session is not
   *   LOBBY_LOCKED, no interaction instance exists, the current one is
   *   not PROMPT_ACTIVE, or the current one is not engineType VOTING;
   * - throw InvalidCandidateSelectionError only when candidateId does
   *   not identify a Candidate belonging to the current interaction
   *   instance;
   * - return the resulting voteId, interactionInstanceId, candidateId,
   *   and updatedAt.
   */
  castVote(
    sessionId: string,
    participantId: string,
    participantToken: string,
    candidateId: string
  ): Promise<{
    voteId: string;
    interactionInstanceId: string;
    candidateId: string;
    updatedAt: string;
  }>;
}
