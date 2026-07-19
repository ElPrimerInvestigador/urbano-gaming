import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { SessionRecord } from "../types";
import { RoomCodeCollisionError } from "../types";
import type {
  SessionEventRecord,
  SessionRepository,
} from "./sessionRepository";

/**
 * Supabase-backed implementation of SessionRepository.
 *
 * Session creation uses the create_session_atomically PostgreSQL function,
 * ensuring the session row and initial event are committed together or
 * rolled back together.
 */
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
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }
}