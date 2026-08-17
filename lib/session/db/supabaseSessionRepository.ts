import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  SessionRecord,
  SessionState,
  InteractionState,
  EngineType,
  VotingCandidateSource,
  VotingResultSummary,
  SegmentTarget,
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
  NoCurrentSegmentToContinueError,
  EmptyPromptTextError,
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
  SegmentRecord,
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

/**
 * Supabase-backed implementation of SessionRepository.
 *
 * Session creation uses the create_session_atomically PostgreSQL function,
 * ensuring the session row and initial event are committed together or
 * rolled back together. joinParticipant follows the identical pattern via
 * a join_participant_atomically function — see
 * supabase/migrations/0004_join_participant_atomically.sql. lockLobby
 * follows the same pattern again via lock_lobby_atomically — see
 * supabase/migrations/0005_lock_lobby_atomically.sql. completeSession
 * follows the same pattern again via complete_session_atomically — see
 * supabase/migrations/0006_complete_session_atomically.sql.
 *
 * Slice 001 (Session / Interaction separation): startSession,
 * submitResponse, closeSubmissions, and revealResults now resolve and
 * operate on the session's *current interaction instance* rather than
 * the session's own state — see supabase/migrations/0017-0020, which
 * forward-fix 0010-0012 and 0008 respectively. This mirrors the
 * existing pairing rather than introducing a new persistence approach.
 */

/**
 * lock_lobby_atomically, join_participant_atomically,
 * start_session_atomically, submit_response_atomically,
 * close_submissions_atomically, and reveal_results_atomically each
 * raise their wrong-state exception with an embedded state name
 * ("... is in <STATE> state, not <REQUIRED_STATE>"), whether the
 * subject is "session" (pre-Slice-001 phrasing) or "current
 * interaction" (Slice 001 phrasing). Extracting it here lets every
 * translation site construct its specific error with the actual
 * state, matching the detail already available from the in-memory
 * repository and the domain-layer fast-path checks.
 */
function extractStateFromGuardMessage(
  message: string
): SessionState | undefined {
  const match = message.match(/is in (\w+) state/);
  return match ? (match[1] as SessionState) : undefined;
}

export class SupabaseSessionRepository implements SessionRepository {
  private client: SupabaseClient;

  constructor(supabaseUrl: string, supabaseServiceKey: string) {
    this.client = createClient(supabaseUrl, supabaseServiceKey);
  }

  async createSession(
    record: SessionRecord,
    initialEvent: SessionEventRecord
  ): Promise<void> {
    const { error } = await this.client.rpc("create_session_atomically", {
      p_session_id: record.sessionId,
      p_room_code: record.roomCode,
      p_host_token: record.hostToken,
      p_state: record.state,
      p_state_version: record.stateVersion,
      p_pause_reason: record.pauseReason,
      p_created_at: record.createdAt,
      p_updated_at: record.updatedAt,
      p_event_type: initialEvent.eventType,
      p_event_payload: initialEvent.payload,
      p_predecessor_session_id: record.predecessorSessionId,
    });

    if (error) {
      if (
        error.code === "23505" &&
        error.message.includes("sessions_room_code_active_unique")
      ) {
        throw new RoomCodeCollisionError();
      }

      if (
        error.code === "23505" &&
        error.message.includes("sessions_predecessor_session_id_unique")
      ) {
        throw new PredecessorAlreadyHasSuccessorError();
      }

      throw error;
    }
  }

  async joinParticipant(
    record: ParticipantRecord,
    joinedEvent: ParticipantJoinedEventRecord
  ): Promise<void> {
    const { error } = await this.client.rpc("join_participant_atomically", {
      p_participant_id: record.participantId,
      p_session_id: record.sessionId,
      p_display_name: record.displayName,
      p_normalized_display_name: record.normalizedDisplayName,
      p_participant_token: record.participantToken,
      p_joined_at: record.joinedAt,
      p_event_type: joinedEvent.eventType,
      p_event_payload: joinedEvent.payload,
    });

    if (error) {
      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("SESSION_NOT_FOUND")
      ) {
        throw new SessionNotFoundError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("SESSION_NOT_JOINABLE")
      ) {
        throw new LobbyNotOpenError(extractStateFromGuardMessage(error.message));
      }

      if (
        error.code === "23505" &&
        error.message.includes(
          "participants_session_display_name_unique"
        )
      ) {
        throw new DisplayNameTakenError();
      }

      throw error;
    }
  }

  async getActiveSessionByRoomCode(
    roomCode: string
  ): Promise<SessionRecord | null> {
    const { data, error } = await this.client
      .from("sessions")
      .select("*")
      .eq("room_code", roomCode)
      .neq("state", "SESSION_COMPLETE")
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;

    return {
      sessionId: data.session_id,
      roomCode: data.room_code,
      hostToken: data.host_token,
      state: data.state,
      stateVersion: data.state_version,
      pauseReason: data.pause_reason,
      currentPromptId: data.current_prompt_id,
      predecessorSessionId: data.predecessor_session_id,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }

  async getSessionById(sessionId: string): Promise<SessionRecord | null> {
    const { data, error } = await this.client
      .from("sessions")
      .select("*")
      .eq("session_id", sessionId)
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;

    return {
      sessionId: data.session_id,
      roomCode: data.room_code,
      hostToken: data.host_token,
      state: data.state,
      stateVersion: data.state_version,
      pauseReason: data.pause_reason,
      currentPromptId: data.current_prompt_id,
      predecessorSessionId: data.predecessor_session_id,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }

  /**
   * Session Continuity slice. predecessor_session_id carries the
   * unique index (0028), so at most one row can ever match.
   */
  async getSuccessorSessionByPredecessorId(
    predecessorSessionId: string
  ): Promise<SessionRecord | null> {
    const { data, error } = await this.client
      .from("sessions")
      .select("*")
      .eq("predecessor_session_id", predecessorSessionId)
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;

    return {
      sessionId: data.session_id,
      roomCode: data.room_code,
      hostToken: data.host_token,
      state: data.state,
      stateVersion: data.state_version,
      pauseReason: data.pause_reason,
      currentPromptId: data.current_prompt_id,
      predecessorSessionId: data.predecessor_session_id,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }

  async lockLobby(
    sessionId: string,
    hostToken: string,
    event: LobbyLockedEventRecord
  ): Promise<{ state: SessionState; stateVersion: number }> {
    const { data, error } = await this.client.rpc("lock_lobby_atomically", {
      p_session_id: sessionId,
      p_host_token: hostToken,
      p_event_type: event.eventType,
      p_event_payload: event.payload,
    });

    if (error) {
      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("SESSION_NOT_FOUND")
      ) {
        throw new SessionNotFoundError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("HOST_TOKEN_MISMATCH")
      ) {
        throw new HostTokenMismatchError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("LOBBY_NOT_OPEN")
      ) {
        throw new LobbyNotOpenError(extractStateFromGuardMessage(error.message));
      }

      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;

    return {
      state: row.state as SessionState,
      stateVersion: row.state_version,
    };
  }

  async getParticipantsForSession(
    sessionId: string
  ): Promise<ParticipantRecord[]> {
    // Secondary sort on participant_id: Postgres does not guarantee a
    // stable tie-break order on joined_at alone, and two joins can land
    // within the same millisecond (see JOIN_SESSION's concurrent-join
    // tests). Without an explicit tiebreaker, repeated calls against the
    // same data are not guaranteed to return the same order.
    const { data, error } = await this.client
      .from("participants")
      .select("*")
      .eq("session_id", sessionId)
      .order("joined_at", { ascending: true })
      .order("participant_id", { ascending: true });

    if (error) throw error;

    return (data ?? []).map((row) => ({
      participantId: row.participant_id,
      sessionId: row.session_id,
      displayName: row.display_name,
      normalizedDisplayName: row.normalized_display_name,
      participantToken: row.participant_token,
      joinedAt: row.joined_at,
    }));
  }

  async completeSession(
    sessionId: string,
    hostToken: string,
    event: SessionCompletedEventRecord
  ): Promise<{ state: SessionState; stateVersion: number }> {
    const { data, error } = await this.client.rpc(
      "complete_session_atomically",
      {
        p_session_id: sessionId,
        p_host_token: hostToken,
        p_event_type: event.eventType,
        p_event_payload: event.payload,
      }
    );

    if (error) {
      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("SESSION_NOT_FOUND")
      ) {
        throw new SessionNotFoundError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("HOST_TOKEN_MISMATCH")
      ) {
        throw new HostTokenMismatchError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("SESSION_ALREADY_COMPLETE")
      ) {
        throw new SessionAlreadyCompleteError();
      }

      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;

    return {
      state: row.state as SessionState,
      stateVersion: row.state_version,
    };
  }

  async getPromptById(promptId: string): Promise<PromptRecord | null> {
    const { data, error } = await this.client
      .from("prompts")
      .select("*")
      .eq("prompt_id", promptId)
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;

    return {
      promptId: data.prompt_id,
      text: data.text,
    };
  }

  async getInteractionInstancesForSession(
    sessionId: string
  ): Promise<InteractionInstanceRecord[]> {
    const { data, error } = await this.client
      .from("interaction_instances")
      .select("*")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true });

    if (error) throw error;

    return (data ?? []).map((row) => ({
      interactionInstanceId: row.interaction_instance_id,
      sessionId: row.session_id,
      segmentId: row.segment_id,
      promptId: row.prompt_id,
      state: row.state as InteractionState,
      engineType: row.engine_type as EngineType,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async getSegmentsForSession(sessionId: string): Promise<SegmentRecord[]> {
    const { data, error } = await this.client
      .from("segments")
      .select("*")
      .eq("session_id", sessionId)
      .order("segment_ordinal", { ascending: true });

    if (error) throw error;

    return (data ?? []).map((row) => ({
      segmentId: row.segment_id,
      sessionId: row.session_id,
      segmentOrdinal: row.segment_ordinal,
      createdAt: row.created_at,
    }));
  }

  /**
   * Slice 007 (Voting Engine): votingCandidateSource arrives here as
   * one structured TypeScript union — this is the one point where it
   * is decomposed into the flat SQL parameters
   * start_session_atomically (0033) actually accepts. Postgres has no
   * native discriminated-union type, and this repository's existing
   * convention already favors flat, typed parameters (multiple_choice_details.options
   * is the one existing jsonb column, used because it's genuinely
   * array-shaped data, not for symmetry with a TypeScript type) — so
   * the decomposition happens in this adapter, not by forcing the
   * database to accept a JSON blob merely to mirror the domain shape.
   */
  async startSession(
    sessionId: string,
    hostToken: string,
    promptText: string,
    preparedQuestionId?: string | null,
    votingCandidateSource?: VotingCandidateSource | null,
    segmentTarget: SegmentTarget = "NEW_SEGMENT"
  ): Promise<{
    interactionInstanceId: string;
    promptId: string;
    state: InteractionState;
    engineType: EngineType;
    segmentNumber: number;
  }> {
    const { data, error } = await this.client.rpc("start_session_atomically", {
      p_session_id: sessionId,
      p_host_token: hostToken,
      p_prompt_text: promptText,
      p_prepared_question_id: preparedQuestionId ?? null,
      p_voting_source_type: votingCandidateSource?.type ?? null,
      p_voting_candidates:
        votingCandidateSource?.type === "HOST_AUTHORED"
          ? votingCandidateSource.candidates
          : null,
      p_voting_source_interaction_instance_id:
        votingCandidateSource?.type === "SUBMISSION"
          ? votingCandidateSource.sourceInteractionInstanceId
          : null,
      p_segment_target: segmentTarget,
    });

    if (error) {
      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("SESSION_NOT_FOUND")
      ) {
        throw new SessionNotFoundError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("HOST_TOKEN_MISMATCH")
      ) {
        throw new HostTokenMismatchError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("LOBBY_NOT_LOCKED")
      ) {
        throw new LobbyNotLockedError(extractStateFromGuardMessage(error.message));
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("PREVIOUS_INTERACTION_NOT_REVEALED")
      ) {
        throw new PreviousInteractionNotRevealedError(
          extractStateFromGuardMessage(error.message) as InteractionState | undefined
        );
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("NO_CURRENT_SEGMENT_TO_CONTINUE")
      ) {
        throw new NoCurrentSegmentToContinueError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("EMPTY_PROMPT_TEXT")
      ) {
        throw new EmptyPromptTextError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("PREPARED_QUESTION_NOT_FOUND")
      ) {
        throw new PreparedQuestionNotFoundError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("PREPARED_QUESTION_ALREADY_CONSUMED")
      ) {
        throw new PreparedQuestionAlreadyConsumedError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("AMBIGUOUS_START_TARGET")
      ) {
        throw new AmbiguousStartSessionTargetError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("INVALID_VOTING_CANDIDATES")
      ) {
        throw new InvalidVotingCandidatesError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("VOTING_SOURCE_INTERACTION_NOT_FOUND")
      ) {
        throw new VotingSourceInteractionNotFoundError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("VOTING_SOURCE_INTERACTION_NOT_ELIGIBLE")
      ) {
        throw new VotingSourceInteractionNotEligibleError();
      }

      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;

    return {
      interactionInstanceId: row.interaction_instance_id,
      promptId: row.prompt_id,
      state: row.state as InteractionState,
      engineType: row.engine_type as EngineType,
      segmentNumber: row.segment_ordinal,
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
    const { data, error } = await this.client.rpc("submit_response_atomically", {
      p_session_id: sessionId,
      p_participant_id: participantId,
      p_participant_token: participantToken,
      p_text: text,
    });

    if (error) {
      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("SESSION_NOT_FOUND")
      ) {
        throw new SessionNotFoundError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("SESSION_ACCESS_DENIED")
      ) {
        throw new SessionAccessDeniedError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("PROMPT_NOT_ACTIVE")
      ) {
        throw new PromptNotActiveError(extractStateFromGuardMessage(error.message));
      }

      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;

    return {
      submissionId: row.submission_id,
      interactionInstanceId: row.interaction_instance_id,
      promptId: row.prompt_id,
      updatedAt: row.updated_at,
    };
  }

  async getSubmissionsForInteractionInstance(
    interactionInstanceId: string
  ): Promise<SubmissionRecord[]> {
    const { data, error } = await this.client
      .from("submissions")
      .select("*")
      .eq("interaction_instance_id", interactionInstanceId);

    if (error) throw error;

    return (data ?? []).map((row) => ({
      submissionId: row.submission_id,
      sessionId: row.session_id,
      interactionInstanceId: row.interaction_instance_id,
      participantId: row.participant_id,
      promptId: row.prompt_id,
      text: row.text,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async closeSubmissions(
    sessionId: string,
    hostToken: string,
    event: SubmissionsClosedEventRecord
  ): Promise<{ interactionInstanceId: string; state: InteractionState }> {
    const { data, error } = await this.client.rpc(
      "close_submissions_atomically",
      {
        p_session_id: sessionId,
        p_host_token: hostToken,
        p_event_type: event.eventType,
        p_event_payload: event.payload,
      }
    );

    if (error) {
      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("SESSION_NOT_FOUND")
      ) {
        throw new SessionNotFoundError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("HOST_TOKEN_MISMATCH")
      ) {
        throw new HostTokenMismatchError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("PROMPT_NOT_ACTIVE")
      ) {
        throw new PromptNotActiveError(extractStateFromGuardMessage(error.message));
      }

      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;

    return {
      interactionInstanceId: row.interaction_instance_id,
      state: row.state as InteractionState,
    };
  }

  async revealResults(
    sessionId: string,
    hostToken: string,
    event: ResultsRevealedEventRecord
  ): Promise<{ interactionInstanceId: string; state: InteractionState }> {
    const { data, error } = await this.client.rpc(
      "reveal_results_atomically",
      {
        p_session_id: sessionId,
        p_host_token: hostToken,
        p_event_type: event.eventType,
        p_event_payload: event.payload,
      }
    );

    if (error) {
      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("SESSION_NOT_FOUND")
      ) {
        throw new SessionNotFoundError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("HOST_TOKEN_MISMATCH")
      ) {
        throw new HostTokenMismatchError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("SUBMISSIONS_NOT_CLOSED")
      ) {
        throw new SubmissionsNotClosedError(extractStateFromGuardMessage(error.message));
      }

      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;

    return {
      interactionInstanceId: row.interaction_instance_id,
      state: row.state as InteractionState,
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
    const { data, error } = await this.client.rpc("award_points_atomically", {
      p_session_id: sessionId,
      p_host_token: hostToken,
      p_interaction_instance_id: interactionInstanceId,
      p_participant_id: participantId,
      p_points: points,
      p_idempotency_key: idempotencyKey,
    });

    if (error) {
      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("SESSION_NOT_FOUND")
      ) {
        throw new SessionNotFoundError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("HOST_TOKEN_MISMATCH")
      ) {
        throw new HostTokenMismatchError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("LOBBY_NOT_LOCKED")
      ) {
        throw new LobbyNotLockedError(extractStateFromGuardMessage(error.message));
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("INTERACTION_NOT_ELIGIBLE")
      ) {
        throw new InteractionInstanceNotEligibleError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("PARTICIPANT_NOT_IN_SESSION")
      ) {
        throw new ParticipantNotInSessionError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("INVALID_POINTS")
      ) {
        throw new InvalidPointsError();
      }

      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;

    return {
      pointAwardId: row.point_award_id,
      sessionId,
      interactionInstanceId: row.interaction_instance_id,
      participantId: row.participant_id,
      points: row.points,
      createdAt: row.created_at,
    };
  }

  async getPointAwardsForSession(sessionId: string): Promise<PointAwardRecord[]> {
    const { data, error } = await this.client
      .from("point_awards")
      .select("*")
      .eq("session_id", sessionId);

    if (error) throw error;

    return (data ?? []).map((row) => ({
      pointAwardId: row.point_award_id,
      sessionId: row.session_id,
      interactionInstanceId: row.interaction_instance_id,
      participantId: row.participant_id,
      points: row.points,
      createdAt: row.created_at,
    }));
  }

  /**
   * Slice 003. No stored procedure — authoring a prepared question has
   * no concurrent invariant to protect (see the interface doc comment).
   * The next ordinal is computed from the current maximum for this
   * session, then assigned sequentially across the batch being
   * inserted in one call.
   */
  async createPreparedQuestions(
    sessionId: string,
    questions: Array<{
      promptText: string;
      options: string[];
      correctOptionIndex: number;
      pointsForCorrect: number;
    }>
  ): Promise<PreparedQuestionRecord[]> {
    const { data: existing, error: existingError } = await this.client
      .from("prepared_questions")
      .select("ordinal")
      .eq("session_id", sessionId)
      .order("ordinal", { ascending: false })
      .limit(1);

    if (existingError) throw existingError;

    let nextOrdinal =
      existing && existing.length > 0 ? existing[0].ordinal + 1 : 1;

    const rows = questions.map((question) => ({
      session_id: sessionId,
      ordinal: nextOrdinal++,
      prompt_text: question.promptText,
      options: question.options,
      correct_option_index: question.correctOptionIndex,
      points_for_correct: question.pointsForCorrect,
    }));

    const { data, error } = await this.client
      .from("prepared_questions")
      .insert(rows)
      .select("*");

    if (error) throw error;

    return (data ?? []).map((row) => ({
      preparedQuestionId: row.prepared_question_id,
      sessionId: row.session_id,
      ordinal: row.ordinal,
      promptText: row.prompt_text,
      options: row.options,
      correctOptionIndex: row.correct_option_index,
      pointsForCorrect: row.points_for_correct,
      consumedAt: row.consumed_at,
      createdAt: row.created_at,
    }));
  }

  async getPreparedQuestionsForSession(
    sessionId: string
  ): Promise<PreparedQuestionRecord[]> {
    const { data, error } = await this.client
      .from("prepared_questions")
      .select("*")
      .eq("session_id", sessionId)
      .order("ordinal", { ascending: true });

    if (error) throw error;

    return (data ?? []).map((row) => ({
      preparedQuestionId: row.prepared_question_id,
      sessionId: row.session_id,
      ordinal: row.ordinal,
      promptText: row.prompt_text,
      options: row.options,
      correctOptionIndex: row.correct_option_index,
      pointsForCorrect: row.points_for_correct,
      consumedAt: row.consumed_at,
      createdAt: row.created_at,
    }));
  }

  async getMultipleChoiceDetailsForInteraction(
    interactionInstanceId: string
  ): Promise<MultipleChoiceDetailsRecord | null> {
    const { data, error } = await this.client
      .from("multiple_choice_details")
      .select("*")
      .eq("interaction_instance_id", interactionInstanceId)
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;

    return {
      interactionInstanceId: data.interaction_instance_id,
      options: data.options,
      correctOptionIndex: data.correct_option_index,
      pointsForCorrect: data.points_for_correct,
    };
  }

  async getVotingCandidatesForInteraction(
    interactionInstanceId: string
  ): Promise<VotingCandidateRecord[]> {
    const { data, error } = await this.client
      .from("voting_candidates")
      .select("*")
      .eq("interaction_instance_id", interactionInstanceId)
      .order("ordinal", { ascending: true });

    if (error) throw error;

    return (data ?? []).map((row) => ({
      candidateId: row.candidate_id,
      interactionInstanceId: row.interaction_instance_id,
      ordinal: row.ordinal,
      label: row.label,
      createdAt: row.created_at,
    }));
  }

  async getVotesForInteractionInstance(
    interactionInstanceId: string
  ): Promise<VoteRecord[]> {
    const { data, error } = await this.client
      .from("votes")
      .select("*")
      .eq("interaction_instance_id", interactionInstanceId);

    if (error) throw error;

    return (data ?? []).map((row) => ({
      voteId: row.vote_id,
      interactionInstanceId: row.interaction_instance_id,
      participantId: row.participant_id,
      candidateId: row.candidate_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * Slice 007. Deliberately two plain selects plus the shared
   * computeVotingResults helper, not a bespoke SQL aggregate function —
   * this mirrors how `standings` is already derived in TypeScript from
   * plain point_awards rows (getSession.ts) rather than via a database
   * aggregate, and guarantees this implementation's ranking semantics
   * can never drift from InMemorySessionRepository's, since both call
   * the exact same function.
   */
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
    const { data, error } = await this.client.rpc("cast_vote_atomically", {
      p_session_id: sessionId,
      p_participant_id: participantId,
      p_participant_token: participantToken,
      p_candidate_id: candidateId,
    });

    if (error) {
      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("SESSION_NOT_FOUND")
      ) {
        throw new SessionNotFoundError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("SESSION_ACCESS_DENIED")
      ) {
        throw new SessionAccessDeniedError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("PROMPT_NOT_ACTIVE")
      ) {
        throw new PromptNotActiveError(extractStateFromGuardMessage(error.message));
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("INVALID_CANDIDATE_SELECTION")
      ) {
        throw new InvalidCandidateSelectionError();
      }

      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;

    return {
      voteId: row.vote_id,
      interactionInstanceId: row.interaction_instance_id,
      candidateId: row.candidate_id,
      updatedAt: row.updated_at,
    };
  }
}
