import { randomUUID } from "node:crypto";

import { loadEnv } from "vite";
import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";

import { SupabaseSessionRepository } from "../lib/session/db/supabaseSessionRepository";
import {
  RoomCodeCollisionError,
  type SessionRecord,
} from "../lib/session/types";
const env = loadEnv("development", process.cwd(), "");

const supabaseUrl = env.SUPABASE_URL;
const supabaseServiceRoleKey =
  env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error(
    "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for contract tests."
  );
}


const repository = new SupabaseSessionRepository(
  supabaseUrl,
  supabaseServiceRoleKey
);

const cleanupClient = createClient(
  supabaseUrl,
  supabaseServiceRoleKey
);

const createdSessionIds: string[] = [];

function generateRoomCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

  return Array.from({ length: 6 }, () => {
    const index = Math.floor(Math.random() * alphabet.length);
    return alphabet[index];
  }).join("");
}

function buildSessionRecord(
  overrides: Partial<SessionRecord> = {}
): SessionRecord {
  const now = new Date().toISOString();

  return {
    sessionId: randomUUID(),
    roomCode: generateRoomCode(),
    hostToken: `contract-host-token-${randomUUID()}`,
    state: "LOBBY_OPEN",
    stateVersion: 1,
    pauseReason: null,
    currentPromptId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function buildInitialEvent(record: SessionRecord) {
  return {
    sessionId: record.sessionId,
    eventType: "SESSION_CREATED",
    payload: {
      roomCode: record.roomCode,
    },
  };
}

afterAll(async () => {
  if (createdSessionIds.length === 0) {
    return;
  }

  const { error: eventsCleanupError } = await cleanupClient
    .from("session_events")
    .delete()
    .in("session_id", createdSessionIds);

  if (eventsCleanupError) {
    throw eventsCleanupError;
  }

  const { error: sessionsCleanupError } = await cleanupClient
    .from("sessions")
    .delete()
    .in("session_id", createdSessionIds);

  if (sessionsCleanupError) {
    throw sessionsCleanupError;
  }
});

describe("SupabaseSessionRepository contract", () => {
  it("translates an active room-code unique violation into RoomCodeCollisionError", async () => {
    const first = buildSessionRecord();
    createdSessionIds.push(first.sessionId);

    await repository.createSession(
      first,
      buildInitialEvent(first)
    );

    const duplicateRoomCode = buildSessionRecord({
      roomCode: first.roomCode,
    });

    await expect(
      repository.createSession(
        duplicateRoomCode,
        buildInitialEvent(duplicateRoomCode)
      )
    ).rejects.toBeInstanceOf(RoomCodeCollisionError);

    const failedSession = await repository.getSessionById(
      duplicateRoomCode.sessionId
    );

    expect(failedSession).toBeNull();
  });

  it("does not translate a host-token unique violation into RoomCodeCollisionError", async () => {
    const first = buildSessionRecord();
    createdSessionIds.push(first.sessionId);

    await repository.createSession(
      first,
      buildInitialEvent(first)
    );

    const duplicateHostToken = buildSessionRecord({
      hostToken: first.hostToken,
    });

    try {
      await repository.createSession(
        duplicateHostToken,
        buildInitialEvent(duplicateHostToken)
      );

      throw new Error(
        "Expected duplicate host token persistence to fail."
      );
    } catch (error: unknown) {
      expect(error).not.toBeInstanceOf(
        RoomCodeCollisionError
      );

      expect(error).toMatchObject({
        code: "23505",
      });
    }

    const failedSession = await repository.getSessionById(
      duplicateHostToken.sessionId
    );

    expect(failedSession).toBeNull();
  });
});