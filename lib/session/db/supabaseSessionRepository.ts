import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { SessionRecord, SessionState } from "../types";
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
} from "../types";
import type {
  SessionEventRecord,
  ParticipantRecord,
  ParticipantJoinedEventRecord,
  LobbyLockedEventRecord,
  SessionCompletedEventRecord,
  PromptRecord,
  SubmissionRecord,
  SubmissionsClosedEventRecord,
  ResultsRevealedEventRecord,
  SessionRepository,
} from "./sessionRepository";

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
 * supabase/migrations/0006_complete_session_atomically.sql. startSession
 * follows the same pattern again via start_session_atomically — see
 * supabase/migrations/0008_start_session_atomically.sql. submitResponse,
 * closeSubmissions, and revealResults follow the same pattern via
 * submit_response_atomically, close_submissions_atomically, and
 * reveal_results_atomically — see supabase/migrations/0010-0012. This
 * mirrors the existing pairing rather than introducing a new
 * persistence approach.
 */

/**
 * lock_lobby_atomically, join_participant_atomically, and
 * start_session_atomically each raise their wrong-state exception with
 * the same embedded shape ("... session is in <STATE> state, not
 * <REQUIRED_STATE>"). Extracting it here lets every translation site
 * construct its specific error (LobbyNotOpenError, LobbyNotLockedError)
 * with the actual state, matching the detail already available from the
 * in-memory repository and the domain-layer fast-path checks.
 */
function extractStateFromGuardMessage(message: string): SessionState | undefined {
  const match = message.match(/session is in (\w+) state/);
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
    });

    if (error) {
      if (
        error.code === "23505" &&
        error.message.includes("sessions_room_code_active_unique")
      ) {
        throw new RoomCodeCollisionError();
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

  async startSession(
    sessionId: string,
    hostToken: string
  ): Promise<{
    state: SessionState;
    stateVersion: number;
    currentPromptId: string;
  }> {
    const { data, error } = await this.client.rpc("start_session_atomically", {
      p_session_id: sessionId,
      p_host_token: hostToken,
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

      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;

    return {
      state: row.state as SessionState,
      stateVersion: row.state_version,
      currentPromptId: row.current_prompt_id,
    };
  }

  async submitResponse(
    sessionId: string,
    participantId: string,
    participantToken: string,
    text: string
  ): Promise<{ submissionId: string; promptId: string; updatedAt: string }> {
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
      promptId: row.prompt_id,
      updatedAt: row.updated_at,
    };
  }

  async getSubmissionsForSession(
    sessionId: string
  ): Promise<SubmissionRecord[]> {
    const { data, error } = await this.client
      .from("submissions")
      .select("*")
      .eq("session_id", sessionId);

    if (error) throw error;

    return (data ?? []).map((row) => ({
      submissionId: row.submission_id,
      sessionId: row.session_id,
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
  ): Promise<{ state: SessionState; stateVersion: number }> {
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
      state: row.state as SessionState,
      stateVersion: row.state_version,
    };
  }

  async revealResults(
    sessionId: string,
    hostToken: string,
    event: ResultsRevealedEventRecord
  ): Promise<{ state: SessionState; stateVersion: number }> {
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
      state: row.state as SessionState,
      stateVersion: row.state_version,
    };
  }
}