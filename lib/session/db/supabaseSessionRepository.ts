import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SessionRecord } from "../types";
import { RoomCodeCollisionError } from "../types";
import type { SessionRepository } from "./sessionRepository";

/**
 * Supabase-backed implementation of SessionRepository.
 * This is the production adapter for the approved stack. Room-code
 * uniqueness is enforced by the partial unique index defined in
 * 0001_create_sessions.sql — this class detects that specific
 * constraint violation and translates it into RoomCodeCollisionError.
 */
export class SupabaseSessionRepository implements SessionRepository {
  private client: SupabaseClient;

  constructor(supabaseUrl: string, supabaseServiceKey: string) {
    this.client = createClient(supabaseUrl, supabaseServiceKey);
  }

  async insertSession(record: SessionRecord): Promise<void> {
    const { error } = await this.client.from("sessions").insert({
      session_id: record.sessionId,
      room_code: record.roomCode,
      host_token: record.hostToken,
      state: record.state,
      state_version: record.stateVersion,
      pause_reason: record.pauseReason,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    });

    if (error) {
      // Postgres unique_violation
      if (error.code === "23505") {
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

  async insertEvent(
    sessionId: string,
    eventType: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    const { error } = await this.client.from("session_events").insert({
      session_id: sessionId,
      event_type: eventType,
      payload,
    });
    if (error) throw error;
  }
}
