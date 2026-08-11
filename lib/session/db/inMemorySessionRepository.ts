import { randomUUID } from "crypto";
import type {
  SessionRecord,
  InteractionState,
  EngineType,
  VotingCandidateSource,
  VotingResultSummary,
} from "../types";
import {
  RoomCodeCollisionError,
  DisplayNameTakenError,
  SessionNotFoundError,
  LobbyNotOpenError,
  LobbyNotLockedError,
  HostTokenMismatchError,
  SessionAlreadyCompleteError,
  SessionAccessDeniedError,
  PromptNotActiveError,
  SubmissionsNotClosedError,
  PreviousInteractionNotRevealedError,
  EmptyPromptTextError,
  PromptTextTooLongError,
  InteractionInstanceNotEligibleError,
  ParticipantNotInSessionError,
  InvalidPointsError,
  PreparedQuestionNotFoundError,
  PreparedQuestionAlreadyConsumedError,
  PredecessorAlreadyHasSuccessorError,
  InvalidVotingCandidatesError,
  VotingSourceInteractionNotFoundError,
  VotingSourceInteractionNotEligibleError,
  InvalidCandidateSelectionError,
  AmbiguousStartSessionTargetError,
} from "../types";
import type {
  SessionEventRecord,
  ParticipantRecord,
  ParticipantJoinedEventRecord,
  LobbyLockedEventRecord,
  SessionCompletedEventRecord,
  PromptRecord,
  InteractionInstanceRecord,
  SubmissionRecord,
  SubmissionsClosedEventRecord,
  ResultsRevealedEventRecord,
  PointAwardRecord,
  MultipleChoiceDetailsRecord,
  PreparedQuestionRecord,
  VotingCandidateRecord,
  VoteRecord,
  SessionRepository,
} from "./sessionRepository";
import { computeVotingResults } from "./sessionRepository";

const MAX_POINTS = 10000;

const MAX_PROMPT_TEXT_LENGTH = 1000;

/**
 * In-memory test double.
 *
 * createSession mirrors the production repository's conceptual atomic
 * operation: validation occurs before either the session or event is stored.
 * joinParticipant follows the identical pattern for participants, and is
 * independently authoritative for session-state — it re-checks the
 * session's current state itself rather than trusting a caller's earlier
 * lookup, mirroring join_participant_atomically's row-locked re-check in
 * the real database function.
 */
export class InMemorySessionRepository implements SessionRepository {
  private sessions = new Map<string, SessionRecord>();

  private participants = new Map<string, ParticipantRecord>();

  private events: Array<SessionEventRecord> = [];

  private submissions = new Map<string, SubmissionRecord>();

  private prompts = new Map<string, PromptRecord>();

  /**
   * Slice 001 (Session / Interaction separation). No seeded content —
   * unlike prompts, which were previously seeded with one fixed row,
   * interaction instances (and the prompts that back them) are always
   * created dynamically from host-supplied text via startSession.
   */
  private interactionInstances = new Map<string, InteractionInstanceRecord>();

  /**
   * Slice 002 (Scored Multi-Round Experience). Keyed by pointAwardId,
   * not by (sessionId, idempotencyKey) — the idempotency lookup below
   * scans values, mirroring how getCurrentInteractionInstance scans
   * rather than maintaining a second index, since this test double
   * prioritizes fidelity to the atomic function's logic over raw
   * performance.
   */
  private pointAwards = new Map<string, PointAwardRecord>();

  /**
   * Idempotency index: `${sessionId}:${idempotencyKey}` -> pointAwardId.
   * Kept separate from PointAwardRecord itself since idempotencyKey is
   * an internal deduplication detail, not part of the record the
   * domain layer or GET_SESSION ever sees.
   */
  private pointAwardIdempotencyIndex = new Map<string, string>();

  /**
   * Slice 003 (Second Interaction Engine). Multiple Choice's own data
   * for one interaction instance — a 1:1 extension, keyed by
   * interactionInstanceId, mirroring multiple_choice_details.
   */
  private multipleChoiceDetails = new Map<string, MultipleChoiceDetailsRecord>();

  /**
   * Slice 003. A session's pre-authored Multiple Choice question
   * queue, keyed by preparedQuestionId.
   */
  private preparedQuestions = new Map<string, PreparedQuestionRecord>();

  /**
   * Slice 007 (Voting Engine). Voting-owned Candidate snapshots, keyed
   * by candidateId. A 1:N extension of interaction_instances, mirroring
   * multipleChoiceDetails' 1:1 extension shape widened to N rows.
   */
  private votingCandidates = new Map<string, VotingCandidateRecord>();

  /**
   * Slice 007. One row per participant who has voted in one Voting
   * interaction instance, keyed by voteId.
   */
  private votes = new Map<string, VoteRecord>();

  /**
   * The current interaction instance for a session is "the most
   * recently created one" — never a stored pointer (see the accepted
   * Slice 001 design's stress test). Returns null if no interaction
   * has ever been started for this session.
   */
  private getCurrentInteractionInstance(
    sessionId: string
  ): InteractionInstanceRecord | null {
    const instances = [...this.interactionInstances.values()]
      .filter((instance) => instance.sessionId === sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    return instances.length > 0 ? instances[instances.length - 1] : null;
  }

  private validateAndTrimPromptText(text: string): string {
    const trimmed = text.trim();

    if (trimmed.length === 0) {
      throw new EmptyPromptTextError();
    }

    if (trimmed.length > MAX_PROMPT_TEXT_LENGTH) {
      throw new PromptTextTooLongError();
    }

    return trimmed;
  }

  async createSession(
    record: SessionRecord,
    initialEvent: SessionEventRecord
  ): Promise<void> {
    const collision = [...this.sessions.values()].some(
      (session) =>
        session.roomCode === record.roomCode &&
        session.state !== "SESSION_COMPLETE"
    );

    if (collision) {
      throw new RoomCodeCollisionError();
    }

    // Mirrors sessions_predecessor_session_id_unique (0028): at most
    // one session may name a given predecessor. Null predecessors
    // never collide with each other, matching Postgres unique-index
    // semantics for null values.
    if (
      record.predecessorSessionId !== null &&
      [...this.sessions.values()].some(
        (session) => session.predecessorSessionId === record.predecessorSessionId
      )
    ) {
      throw new PredecessorAlreadyHasSuccessorError();
    }

    if (this.sessions.has(record.sessionId)) {
      throw new Error("Duplicate session_id insert.");
    }

    if (initialEvent.sessionId !== record.sessionId) {
      throw new Error(
        "Initial event sessionId must match the session being created."
      );
    }

    /*
     * No mutation occurs before every validation succeeds. This preserves
     * all-or-nothing behavior within the in-memory implementation.
     */
    this.sessions.set(record.sessionId, { ...record });

    this.events.push({
      sessionId: initialEvent.sessionId,
      eventType: initialEvent.eventType,
      payload: { ...initialEvent.payload },
    });
  }

  async joinParticipant(
    record: ParticipantRecord,
    joinedEvent: ParticipantJoinedEventRecord
  ): Promise<void> {
    // Authoritative session-state re-check, independent of any earlier
    // application-layer lookup. Mirrors join_participant_atomically's
    // row-locked re-check in the real database function.
    const session = this.sessions.get(record.sessionId);

    if (!session) {
      throw new SessionNotFoundError();
    }

    if (session.state !== "LOBBY_OPEN") {
      throw new LobbyNotOpenError(session.state);
    }

    const nameCollision = [...this.participants.values()].some(
      (participant) =>
        participant.sessionId === record.sessionId &&
        participant.normalizedDisplayName === record.normalizedDisplayName
    );

    if (nameCollision) {
      throw new DisplayNameTakenError();
    }

    if (this.participants.has(record.participantId)) {
      throw new Error("Duplicate participant_id insert.");
    }

    if (joinedEvent.sessionId !== record.sessionId) {
      throw new Error(
        "Joined event sessionId must match the participant's session."
      );
    }

    /*
     * No mutation occurs before every validation succeeds, matching
     * createSession's all-or-nothing behavior.
     */
    this.participants.set(record.participantId, { ...record });

    this.events.push({
      sessionId: joinedEvent.sessionId,
      eventType: joinedEvent.eventType,
      payload: { ...joinedEvent.payload },
    });
  }

  async getActiveSessionByRoomCode(
    roomCode: string
  ): Promise<SessionRecord | null> {
    const match = [...this.sessions.values()].find(
      (session) =>
        session.roomCode === roomCode && session.state !== "SESSION_COMPLETE"
    );

    return match ?? null;
  }

  async getSessionById(sessionId: string): Promise<SessionRecord | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async getSuccessorSessionByPredecessorId(
    predecessorSessionId: string
  ): Promise<SessionRecord | null> {
    const match = [...this.sessions.values()].find(
      (session) => session.predecessorSessionId === predecessorSessionId
    );

    return match ?? null;
  }

  async lockLobby(
    sessionId: string,
    hostToken: string,
    event: LobbyLockedEventRecord
  ): Promise<{ state: SessionRecord["state"]; stateVersion: number }> {
    // Authoritative host-token and session-state re-check, independent of
    // any earlier application-layer lookup. Mirrors
    // lock_lobby_atomically's row-locked re-check in the real database
    // function.
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new SessionNotFoundError();
    }

    if (session.hostToken !== hostToken) {
      throw new HostTokenMismatchError();
    }

    if (session.state !== "LOBBY_OPEN") {
      throw new LobbyNotOpenError(session.state);
    }

    if (event.sessionId !== sessionId) {
      throw new Error(
        "Lock event sessionId must match the session being locked."
      );
    }

    const updated: SessionRecord = {
      ...session,
      state: "LOBBY_LOCKED",
      stateVersion: session.stateVersion + 1,
      updatedAt: new Date().toISOString(),
    };

    this.sessions.set(sessionId, updated);

    this.events.push({
      sessionId: event.sessionId,
      eventType: event.eventType,
      payload: { ...event.payload },
    });

    return { state: updated.state, stateVersion: updated.stateVersion };
  }

  async getParticipantsForSession(
    sessionId: string
  ): Promise<ParticipantRecord[]> {
    return [...this.participants.values()]
      .filter((participant) => participant.sessionId === sessionId)
      .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
  }

  async completeSession(
    sessionId: string,
    hostToken: string,
    event: SessionCompletedEventRecord
  ): Promise<{ state: SessionRecord["state"]; stateVersion: number }> {
    // Authoritative host-token and session-state re-check, independent of
    // any earlier application-layer lookup. Mirrors
    // complete_session_atomically's row-locked re-check in the real
    // database function.
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new SessionNotFoundError();
    }

    if (session.hostToken !== hostToken) {
      throw new HostTokenMismatchError();
    }

    if (session.state === "SESSION_COMPLETE") {
      throw new SessionAlreadyCompleteError();
    }

    if (event.sessionId !== sessionId) {
      throw new Error(
        "Completion event sessionId must match the session being completed."
      );
    }

    const updated: SessionRecord = {
      ...session,
      state: "SESSION_COMPLETE",
      stateVersion: session.stateVersion + 1,
      updatedAt: new Date().toISOString(),
    };

    this.sessions.set(sessionId, updated);

    this.events.push({
      sessionId: event.sessionId,
      eventType: event.eventType,
      payload: { ...event.payload },
    });

    return { state: updated.state, stateVersion: updated.stateVersion };
  }

  async getPromptById(promptId: string): Promise<PromptRecord | null> {
    return this.prompts.get(promptId) ?? null;
  }

  async getInteractionInstancesForSession(
    sessionId: string
  ): Promise<InteractionInstanceRecord[]> {
    return [...this.interactionInstances.values()]
      .filter((instance) => instance.sessionId === sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async startSession(
    sessionId: string,
    hostToken: string,
    promptText: string,
    preparedQuestionId?: string | null,
    votingCandidateSource?: VotingCandidateSource | null
  ): Promise<{
    interactionInstanceId: string;
    promptId: string;
    state: InteractionState;
    engineType: EngineType;
  }> {
    // Authoritative host-token and session-state re-check, independent of
    // any earlier application-layer lookup. Mirrors
    // start_session_atomically's row-locked re-check in the real
    // database function.
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new SessionNotFoundError();
    }

    if (session.hostToken !== hostToken) {
      throw new HostTokenMismatchError();
    }

    if (session.state !== "LOBBY_LOCKED") {
      throw new LobbyNotLockedError(session.state);
    }

    // Re-invocable precondition: the session's current interaction
    // instance, if any, must already be RESULT_REVEAL before another
    // one may begin.
    const previousInteraction = this.getCurrentInteractionInstance(sessionId);
    if (previousInteraction && previousInteraction.state !== "RESULT_REVEAL") {
      throw new PreviousInteractionNotRevealedError(previousInteraction.state);
    }

    // Slice 007: authoritative re-check mirroring the atomic SQL
    // function's identical guard — see 0033's comment.
    if (preparedQuestionId && votingCandidateSource) {
      throw new AmbiguousStartSessionTargetError();
    }

    const now = new Date().toISOString();
    let promptTextToStore: string;
    let engineType: EngineType;
    let preparedQuestionToConsume: PreparedQuestionRecord | undefined;
    let votingCandidateLabels: string[] | undefined;

    if (preparedQuestionId) {
      // Slice 003: explicit prepared-question target — the caller
      // names the exact question, this method never infers one.
      const prepared = this.preparedQuestions.get(preparedQuestionId);

      if (!prepared || prepared.sessionId !== sessionId) {
        throw new PreparedQuestionNotFoundError();
      }

      if (prepared.consumedAt !== null) {
        throw new PreparedQuestionAlreadyConsumedError();
      }

      promptTextToStore = prepared.promptText;
      engineType = "MULTIPLE_CHOICE";
      preparedQuestionToConsume = prepared;
    } else if (votingCandidateSource) {
      // Slice 007 (Voting Engine): unlike the prepared-question path,
      // Voting always needs host-framed prompt text — neither
      // Candidate source provides one.
      promptTextToStore = this.validateAndTrimPromptText(promptText);
      engineType = "VOTING";

      if (votingCandidateSource.type === "HOST_AUTHORED") {
        const trimmed = votingCandidateSource.candidates.map((c) => c.trim());
        const distinct = new Set(trimmed);
        if (
          trimmed.length < 2 ||
          trimmed.some((c) => c.length === 0) ||
          distinct.size !== trimmed.length
        ) {
          throw new InvalidVotingCandidatesError();
        }
        votingCandidateLabels = trimmed;
      } else {
        const source = this.interactionInstances.get(
          votingCandidateSource.sourceInteractionInstanceId
        );
        if (!source || source.sessionId !== sessionId) {
          throw new VotingSourceInteractionNotFoundError();
        }
        if (source.engineType !== "OPEN_RESPONSE" || source.state !== "RESULT_REVEAL") {
          throw new VotingSourceInteractionNotEligibleError();
        }
        const sourceSubmissions = [...this.submissions.values()]
          .filter((s) => s.interactionInstanceId === source.interactionInstanceId)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        if (sourceSubmissions.length === 0) {
          throw new VotingSourceInteractionNotEligibleError();
        }
        votingCandidateLabels = sourceSubmissions.map((s) => s.text);
      }
    } else {
      promptTextToStore = this.validateAndTrimPromptText(promptText);
      engineType = "OPEN_RESPONSE";
    }

    const promptId = randomUUID();
    this.prompts.set(promptId, { promptId, text: promptTextToStore });

    const interactionInstanceId = randomUUID();
    const interactionInstance: InteractionInstanceRecord = {
      interactionInstanceId,
      sessionId,
      promptId,
      state: "PROMPT_ACTIVE",
      engineType,
      createdAt: now,
      updatedAt: now,
    };
    this.interactionInstances.set(interactionInstanceId, interactionInstance);

    if (preparedQuestionToConsume) {
      this.multipleChoiceDetails.set(interactionInstanceId, {
        interactionInstanceId,
        options: preparedQuestionToConsume.options,
        correctOptionIndex: preparedQuestionToConsume.correctOptionIndex,
        pointsForCorrect: preparedQuestionToConsume.pointsForCorrect,
      });

      this.preparedQuestions.set(preparedQuestionToConsume.preparedQuestionId, {
        ...preparedQuestionToConsume,
        consumedAt: now,
      });
    }

    if (votingCandidateLabels) {
      votingCandidateLabels.forEach((label, ordinal) => {
        const candidateId = randomUUID();
        this.votingCandidates.set(candidateId, {
          candidateId,
          interactionInstanceId,
          ordinal,
          label,
          createdAt: now,
        });
      });
    }

    this.events.push({
      sessionId,
      eventType: "INTERACTION_STARTED",
      payload: { interactionInstanceId, promptId, engineType },
    });

    return {
      interactionInstanceId,
      promptId,
      state: "PROMPT_ACTIVE",
      engineType,
    };
  }

  async submitResponse(
    sessionId: string,
    participantId: string,
    participantToken: string,
    text: string
  ): Promise<{
    submissionId: string;
    interactionInstanceId: string;
    promptId: string;
    updatedAt: string;
  }> {
    // Authoritative participant-token and session/interaction-state
    // re-check, independent of any earlier application-layer lookup.
    // Mirrors submit_response_atomically's row-locked re-check in the
    // real database function. Also re-resolves the current interaction
    // instance here (not trusting an earlier domain-layer read), since
    // that's what the submission and its event are scoped to.
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new SessionNotFoundError();
    }

    const participant = this.participants.get(participantId);
    if (!participant || participant.participantToken !== participantToken) {
      throw new SessionAccessDeniedError();
    }

    const interactionInstance = this.getCurrentInteractionInstance(sessionId);

    if (
      session.state !== "LOBBY_LOCKED" ||
      !interactionInstance ||
      interactionInstance.state !== "PROMPT_ACTIVE"
    ) {
      throw new PromptNotActiveError(interactionInstance?.state);
    }

    const { interactionInstanceId, promptId } = interactionInstance;
    const now = new Date().toISOString();

    // Upsert: one submission per participant per interaction instance.
    // "Last write wins" is an explicit MVP implementation decision, not
    // a permanent gameplay rule — see SubmitResponseResult's doc
    // comment.
    const existing = [...this.submissions.values()].find(
      (submission) =>
        submission.interactionInstanceId === interactionInstanceId &&
        submission.participantId === participantId
    );

    const submissionId = existing?.submissionId ?? randomUUID();
    const record: SubmissionRecord = {
      submissionId,
      sessionId,
      interactionInstanceId,
      participantId,
      promptId,
      text,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.submissions.set(submissionId, record);

    this.events.push({
      sessionId,
      eventType: "RESPONSE_SUBMITTED",
      payload: { participantId, interactionInstanceId, promptId },
    });

    return { submissionId, interactionInstanceId, promptId, updatedAt: now };
  }

  async getSubmissionsForInteractionInstance(
    interactionInstanceId: string
  ): Promise<SubmissionRecord[]> {
    return [...this.submissions.values()].filter(
      (submission) => submission.interactionInstanceId === interactionInstanceId
    );
  }

  async closeSubmissions(
    sessionId: string,
    hostToken: string,
    event: SubmissionsClosedEventRecord
  ): Promise<{ interactionInstanceId: string; state: InteractionState }> {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new SessionNotFoundError();
    }

    if (session.hostToken !== hostToken) {
      throw new HostTokenMismatchError();
    }

    const interactionInstance = this.getCurrentInteractionInstance(sessionId);

    if (
      session.state !== "LOBBY_LOCKED" ||
      !interactionInstance ||
      interactionInstance.state !== "PROMPT_ACTIVE"
    ) {
      throw new PromptNotActiveError(interactionInstance?.state);
    }

    const updated: InteractionInstanceRecord = {
      ...interactionInstance,
      state: "SUBMISSIONS_CLOSED",
      updatedAt: new Date().toISOString(),
    };
    this.interactionInstances.set(updated.interactionInstanceId, updated);

    this.events.push({
      sessionId: event.sessionId,
      eventType: event.eventType,
      payload: { ...event.payload },
    });

    return {
      interactionInstanceId: updated.interactionInstanceId,
      state: updated.state,
    };
  }

  async revealResults(
    sessionId: string,
    hostToken: string,
    event: ResultsRevealedEventRecord
  ): Promise<{ interactionInstanceId: string; state: InteractionState }> {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new SessionNotFoundError();
    }

    if (session.hostToken !== hostToken) {
      throw new HostTokenMismatchError();
    }

    const interactionInstance = this.getCurrentInteractionInstance(sessionId);

    if (
      session.state !== "LOBBY_LOCKED" ||
      !interactionInstance ||
      interactionInstance.state !== "SUBMISSIONS_CLOSED"
    ) {
      throw new SubmissionsNotClosedError(interactionInstance?.state);
    }

    const updated: InteractionInstanceRecord = {
      ...interactionInstance,
      state: "RESULT_REVEAL",
      updatedAt: new Date().toISOString(),
    };
    this.interactionInstances.set(updated.interactionInstanceId, updated);

    this.events.push({
      sessionId: event.sessionId,
      eventType: event.eventType,
      payload: { ...event.payload },
    });

    // Slice 003 (Second Interaction Engine): for a Multiple Choice
    // interaction, automatic scoring happens here, in the same
    // synchronous call as the state transition above — mirroring
    // reveal_results_atomically's single-transaction guarantee (see
    // 0027's migration comment). A single-threaded in-memory double
    // cannot demonstrate the atomicity property itself (nothing here
    // can partially fail), but the *shape* — evaluation as an
    // inseparable step of reveal, not a later independent call — is
    // reproduced faithfully so in-memory tests exercise the same logic
    // a live contract test verifies is transactional.
    const details = this.multipleChoiceDetails.get(updated.interactionInstanceId);
    if (details) {
      const submissions = await this.getSubmissionsForInteractionInstance(
        updated.interactionInstanceId
      );

      for (const submission of submissions) {
        if (submission.text !== String(details.correctOptionIndex)) {
          continue;
        }

        // Deterministic per-(interaction, participant) key so this
        // step can never double-award if ever re-run. Unlike
        // award_points_atomically's real-Postgres counterpart, this
        // in-memory idempotency_key has no uuid-column constraint to
        // satisfy, so the readable form is used directly rather than
        // hashed.
        const idempotencyKey = `mc-auto:${updated.interactionInstanceId}:${submission.participantId}`;
        const indexKey = `${sessionId}:${idempotencyKey}`;

        if (this.pointAwardIdempotencyIndex.has(indexKey)) {
          continue;
        }

        const pointAwardId = randomUUID();
        const award: PointAwardRecord = {
          pointAwardId,
          sessionId,
          interactionInstanceId: updated.interactionInstanceId,
          participantId: submission.participantId,
          points: details.pointsForCorrect,
          createdAt: new Date().toISOString(),
        };

        this.pointAwards.set(pointAwardId, award);
        this.pointAwardIdempotencyIndex.set(indexKey, pointAwardId);

        this.events.push({
          sessionId,
          eventType: "POINTS_AWARDED",
          payload: {
            pointAwardId,
            interactionInstanceId: updated.interactionInstanceId,
            participantId: submission.participantId,
            points: details.pointsForCorrect,
          },
        });
      }
    }

    return {
      interactionInstanceId: updated.interactionInstanceId,
      state: updated.state,
    };
  }

  async awardPoints(
    sessionId: string,
    hostToken: string,
    interactionInstanceId: string,
    participantId: string,
    points: number,
    idempotencyKey: string
  ): Promise<PointAwardRecord> {
    // Step 1: idempotency-first resolution, scoped to this session. No
    // other check runs if a match is found — this is what lets a
    // retry succeed identically even after the session has since
    // progressed past the interaction this award targeted.
    const indexKey = `${sessionId}:${idempotencyKey}`;
    const existingId = this.pointAwardIdempotencyIndex.get(indexKey);
    if (existingId) {
      const existing = this.pointAwards.get(existingId);
      if (existing) {
        return existing;
      }
    }

    // Step 2: new-award path — full validation, reached only when the
    // idempotency key is genuinely new for this session.
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new SessionNotFoundError();
    }

    if (session.hostToken !== hostToken) {
      throw new HostTokenMismatchError();
    }

    if (session.state !== "LOBBY_LOCKED") {
      throw new LobbyNotLockedError(session.state);
    }

    const currentInteraction = this.getCurrentInteractionInstance(sessionId);

    if (
      !currentInteraction ||
      currentInteraction.interactionInstanceId !== interactionInstanceId ||
      currentInteraction.state !== "RESULT_REVEAL"
    ) {
      throw new InteractionInstanceNotEligibleError();
    }

    const participant = this.participants.get(participantId);
    if (!participant || participant.sessionId !== sessionId) {
      throw new ParticipantNotInSessionError();
    }

    if (!Number.isInteger(points) || points <= 0 || points > MAX_POINTS) {
      throw new InvalidPointsError();
    }

    // Step 3: insert. A genuine race between two concurrent requests
    // carrying the same (sessionId, idempotencyKey) cannot occur
    // within a single-threaded in-memory double the way it can against
    // real Postgres — this re-check exists so the logic mirrors the
    // atomic function's shape exactly, not because JS needs it here.
    const raceWinnerId = this.pointAwardIdempotencyIndex.get(indexKey);
    if (raceWinnerId) {
      const winner = this.pointAwards.get(raceWinnerId);
      if (winner) {
        return winner;
      }
    }

    const pointAwardId = randomUUID();
    const record: PointAwardRecord = {
      pointAwardId,
      sessionId,
      interactionInstanceId,
      participantId,
      points,
      createdAt: new Date().toISOString(),
    };

    this.pointAwards.set(pointAwardId, record);
    this.pointAwardIdempotencyIndex.set(indexKey, pointAwardId);

    this.events.push({
      sessionId,
      eventType: "POINTS_AWARDED",
      payload: { pointAwardId, interactionInstanceId, participantId, points },
    });

    return record;
  }

  async getPointAwardsForSession(sessionId: string): Promise<PointAwardRecord[]> {
    return [...this.pointAwards.values()].filter(
      (award) => award.sessionId === sessionId
    );
  }

  /** Test-only helper, not part of the repository interface. */
  _allPointAwards() {
    return [...this.pointAwards.values()];
  }

  /** Test-only helper, not part of the repository interface. */
  _getEventsForSession(sessionId: string) {
    return this.events.filter((event) => event.sessionId === sessionId);
  }

  /** Test-only helper to inspect current size and state. */
  _all() {
    return [...this.sessions.values()];
  }

  /** Test-only helper to inspect stored participants. */
  _allParticipants() {
    return [...this.participants.values()];
  }

  /**
   * Test-only helper to jump a session directly to SESSION_COMPLETE
   * without going through completeSession()'s host-token check —
   * useful for tests that only need a completed session as setup, not
   * as the behavior under test.
   */
  _forceComplete(sessionId: string) {
    const session = this.sessions.get(sessionId);

    if (session) {
      this.sessions.set(sessionId, {
        ...session,
        state: "SESSION_COMPLETE",
      });
    }
  }

  /** Test-only helper to force a session into an arbitrary state directly. */
  _forceState(sessionId: string, state: SessionRecord["state"]) {
    const session = this.sessions.get(sessionId);

    if (session) {
      this.sessions.set(sessionId, { ...session, state });
    }
  }

  /** Test-only helper, not part of the repository interface. */
  _allInteractionInstances() {
    return [...this.interactionInstances.values()];
  }

  async createPreparedQuestions(
    sessionId: string,
    questions: Array<{
      promptText: string;
      options: string[];
      correctOptionIndex: number;
      pointsForCorrect: number;
    }>
  ): Promise<PreparedQuestionRecord[]> {
    const existing = await this.getPreparedQuestionsForSession(sessionId);
    let nextOrdinal =
      existing.length > 0
        ? Math.max(...existing.map((q) => q.ordinal)) + 1
        : 1;

    const created: PreparedQuestionRecord[] = [];
    const now = new Date().toISOString();

    for (const question of questions) {
      const record: PreparedQuestionRecord = {
        preparedQuestionId: randomUUID(),
        sessionId,
        ordinal: nextOrdinal,
        promptText: question.promptText,
        options: question.options,
        correctOptionIndex: question.correctOptionIndex,
        pointsForCorrect: question.pointsForCorrect,
        consumedAt: null,
        createdAt: now,
      };

      this.preparedQuestions.set(record.preparedQuestionId, record);
      created.push(record);
      nextOrdinal += 1;
    }

    return created;
  }

  async getPreparedQuestionsForSession(
    sessionId: string
  ): Promise<PreparedQuestionRecord[]> {
    return [...this.preparedQuestions.values()]
      .filter((question) => question.sessionId === sessionId)
      .sort((a, b) => a.ordinal - b.ordinal);
  }

  async getMultipleChoiceDetailsForInteraction(
    interactionInstanceId: string
  ): Promise<MultipleChoiceDetailsRecord | null> {
    return this.multipleChoiceDetails.get(interactionInstanceId) ?? null;
  }

  /** Test-only helper, not part of the repository interface. */
  _allPreparedQuestions() {
    return [...this.preparedQuestions.values()];
  }

  /** Test-only helper, not part of the repository interface. */
  _allMultipleChoiceDetails() {
    return [...this.multipleChoiceDetails.values()];
  }

  async getVotingCandidatesForInteraction(
    interactionInstanceId: string
  ): Promise<VotingCandidateRecord[]> {
    return [...this.votingCandidates.values()]
      .filter((c) => c.interactionInstanceId === interactionInstanceId)
      .sort((a, b) => a.ordinal - b.ordinal);
  }

  async getVotesForInteractionInstance(
    interactionInstanceId: string
  ): Promise<VoteRecord[]> {
    return [...this.votes.values()].filter(
      (v) => v.interactionInstanceId === interactionInstanceId
    );
  }

  async getVotingResultsForInteractionInstance(
    interactionInstanceId: string
  ): Promise<VotingResultSummary[]> {
    const candidates = await this.getVotingCandidatesForInteraction(
      interactionInstanceId
    );
    const votes = await this.getVotesForInteractionInstance(interactionInstanceId);
    return computeVotingResults(candidates, votes);
  }

  async castVote(
    sessionId: string,
    participantId: string,
    participantToken: string,
    candidateId: string
  ): Promise<{
    voteId: string;
    interactionInstanceId: string;
    candidateId: string;
    updatedAt: string;
  }> {
    // Authoritative participant-token and session/interaction-state
    // re-check, mirroring submitResponse's identical discipline.
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new SessionNotFoundError();
    }

    const participant = this.participants.get(participantId);
    if (!participant || participant.participantToken !== participantToken) {
      throw new SessionAccessDeniedError();
    }

    const interactionInstance = this.getCurrentInteractionInstance(sessionId);

    if (
      session.state !== "LOBBY_LOCKED" ||
      !interactionInstance ||
      interactionInstance.state !== "PROMPT_ACTIVE" ||
      interactionInstance.engineType !== "VOTING"
    ) {
      throw new PromptNotActiveError(interactionInstance?.state);
    }

    const { interactionInstanceId } = interactionInstance;

    const candidate = this.votingCandidates.get(candidateId);
    if (!candidate || candidate.interactionInstanceId !== interactionInstanceId) {
      throw new InvalidCandidateSelectionError();
    }

    const now = new Date().toISOString();

    // Upsert: one vote per participant per interaction instance,
    // "last write wins" while PROMPT_ACTIVE — mirrors submitResponse's
    // identical MVP decision, applied to votes instead of submissions.
    const existing = [...this.votes.values()].find(
      (v) =>
        v.interactionInstanceId === interactionInstanceId &&
        v.participantId === participantId
    );

    const voteId = existing?.voteId ?? randomUUID();
    const record: VoteRecord = {
      voteId,
      interactionInstanceId,
      participantId,
      candidateId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.votes.set(voteId, record);

    this.events.push({
      sessionId,
      eventType: "VOTE_CAST",
      payload: { participantId, interactionInstanceId, candidateId },
    });

    return { voteId, interactionInstanceId, candidateId, updatedAt: now };
  }

  /** Test-only helper, not part of the repository interface. */
  _allVotingCandidates() {
    return [...this.votingCandidates.values()];
  }

  /** Test-only helper, not part of the repository interface. */
  _allVotes() {
    return [...this.votes.values()];
  }
}
