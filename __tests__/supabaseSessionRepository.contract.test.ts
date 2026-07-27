import { randomUUID } from "node:crypto";

import { loadEnv } from "vite";
import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";

import { SupabaseSessionRepository } from "../lib/session/db/supabaseSessionRepository";
import type { ParticipantRecord } from "../lib/session/db/sessionRepository";
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

function buildParticipantRecord(
  sessionId: string,
  overrides: Partial<ParticipantRecord> = {}
): ParticipantRecord {
  const displayName = overrides.displayName ?? `Contract-${randomUUID().slice(0, 8)}`;

  return {
    participantId: randomUUID(),
    sessionId,
    displayName,
    normalizedDisplayName: displayName.toLowerCase(),
    participantToken: `contract-participant-token-${randomUUID()}`,
    joinedAt: new Date().toISOString(),
    ...overrides,
  };
}

function buildJoinedEvent(record: ParticipantRecord) {
  return {
    sessionId: record.sessionId,
    eventType: "PARTICIPANT_JOINED" as const,
    payload: {
      participantId: record.participantId,
      displayName: record.displayName,
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

/**
 * These tests exist to prove each atomic Postgres function actually
 * executes and returns the expected shape against a real, live
 * database — not to re-cover the exhaustive edge cases and error paths
 * already exercised by the in-memory repository's 121 behavioral
 * tests. One coherent, realistic sequence per concern, not a matrix.
 *
 * Motivation: a live human playtest found two real bugs (ambiguous
 * column references between RETURNS TABLE output parameters and
 * identically-named source columns) in lockLobby/startSession/
 * completeSession/closeSubmissions/revealResults and submitResponse —
 * bugs that passing in-memory tests could never have caught, since SQL
 * identifier resolution doesn't exist in a plain JS test double. This
 * suite exists specifically to catch that class of bug automatically,
 * going forward, rather than depending on a human to manually click
 * through the full loop again.
 *
 * Slice 001 (Session / Interaction separation): startSession,
 * submitResponse, closeSubmissions, and revealResults now resolve and
 * mutate the session's *current interaction instance*, not the
 * session's own state/state_version — the session stays LOBBY_LOCKED
 * (state_version 2, set by LOCK_LOBBY) through every interaction it
 * runs, only moving again at COMPLETE_SESSION.
 */
describe("SupabaseSessionRepository contract — full lifecycle against live Postgres", () => {
  it("exercises every remaining atomic function through one complete, realistic session lifecycle, including a second sequential interaction", async () => {
    // CREATE_SESSION
    const session = buildSessionRecord();
    createdSessionIds.push(session.sessionId);
    await repository.createSession(session, buildInitialEvent(session));

    // JOIN_SESSION
    const participant = buildParticipantRecord(session.sessionId);
    await repository.joinParticipant(participant, buildJoinedEvent(participant));

    const resolvedByRoomCode = await repository.getActiveSessionByRoomCode(session.roomCode);
    expect(resolvedByRoomCode?.sessionId).toBe(session.sessionId);

    const participants = await repository.getParticipantsForSession(session.sessionId);
    expect(participants).toHaveLength(1);
    expect(participants[0].participantId).toBe(participant.participantId);

    // LOCK_LOBBY
    const lockResult = await repository.lockLobby(session.sessionId, session.hostToken, {
      sessionId: session.sessionId,
      eventType: "LOBBY_LOCKED",
      payload: {},
    });
    expect(lockResult).toEqual({ state: "LOBBY_LOCKED", stateVersion: 2 });

    // START_SESSION — first interaction
    const firstStart = await repository.startSession(
      session.sessionId,
      session.hostToken,
      "Initial contract-test prompt"
    );
    expect(firstStart.state).toBe("PROMPT_ACTIVE");
    expect(firstStart.interactionInstanceId).toBeTruthy();
    expect(firstStart.promptId).toBeTruthy();

    // GET_SESSION's prompt hydration path
    const prompt = await repository.getPromptById(firstStart.promptId);
    expect(prompt).not.toBeNull();
    expect(prompt?.promptId).toBe(firstStart.promptId);
    expect(prompt?.text).toBe("Initial contract-test prompt");

    // Session's own state/state_version are untouched by START_SESSION.
    const afterFirstStart = await repository.getSessionById(session.sessionId);
    expect(afterFirstStart?.state).toBe("LOBBY_LOCKED");
    expect(afterFirstStart?.stateVersion).toBe(2);

    // SUBMIT_RESPONSE — initial submission
    const firstSubmit = await repository.submitResponse(
      session.sessionId,
      participant.participantId,
      participant.participantToken,
      "Initial contract-test response"
    );
    expect(firstSubmit.submissionId).toBeTruthy();
    expect(firstSubmit.interactionInstanceId).toBe(firstStart.interactionInstanceId);
    expect(firstSubmit.promptId).toBe(firstStart.promptId);

    // SUBMIT_RESPONSE — revision, proving the live ON CONFLICT upsert
    // ("last write wins") actually works against real Postgres, not
    // just in the in-memory double's plain Map overwrite.
    const secondSubmit = await repository.submitResponse(
      session.sessionId,
      participant.participantId,
      participant.participantToken,
      "Revised contract-test response"
    );
    expect(secondSubmit.submissionId).toBe(firstSubmit.submissionId);

    const firstInteractionSubmissions =
      await repository.getSubmissionsForInteractionInstance(
        firstStart.interactionInstanceId
      );
    expect(firstInteractionSubmissions).toHaveLength(1);
    expect(firstInteractionSubmissions[0].text).toBe("Revised contract-test response");

    // CLOSE_SUBMISSIONS
    const closeResult = await repository.closeSubmissions(session.sessionId, session.hostToken, {
      sessionId: session.sessionId,
      eventType: "SUBMISSIONS_CLOSED",
      payload: {},
    });
    expect(closeResult).toEqual({
      interactionInstanceId: firstStart.interactionInstanceId,
      state: "SUBMISSIONS_CLOSED",
    });

    // REVEAL_RESULTS
    const revealResult = await repository.revealResults(session.sessionId, session.hostToken, {
      sessionId: session.sessionId,
      eventType: "RESULTS_REVEALED",
      payload: {},
    });
    expect(revealResult).toEqual({
      interactionInstanceId: firstStart.interactionInstanceId,
      state: "RESULT_REVEAL",
    });

    // START_SESSION — second interaction, proving the re-invocable
    // Slice 001 capability against real Postgres: re-invoking START_SESSION
    // is only legal once the previous interaction instance is RESULT_REVEAL,
    // and the row-locked re-check inside start_session_atomically must
    // authoritatively confirm that, not just this test's own lookups.
    const secondStart = await repository.startSession(
      session.sessionId,
      session.hostToken,
      "Second contract-test prompt"
    );
    expect(secondStart.state).toBe("PROMPT_ACTIVE");
    expect(secondStart.interactionInstanceId).not.toBe(firstStart.interactionInstanceId);
    expect(secondStart.promptId).not.toBe(firstStart.promptId);

    const instances = await repository.getInteractionInstancesForSession(session.sessionId);
    expect(instances).toHaveLength(2);
    expect(instances[0].interactionInstanceId).toBe(firstStart.interactionInstanceId);
    expect(instances[0].state).toBe("RESULT_REVEAL");
    expect(instances[1].interactionInstanceId).toBe(secondStart.interactionInstanceId);
    expect(instances[1].state).toBe("PROMPT_ACTIVE");

    // The first interaction's submissions must not bleed into the second.
    const secondInteractionSubmissionsBeforeSubmit =
      await repository.getSubmissionsForInteractionInstance(
        secondStart.interactionInstanceId
      );
    expect(secondInteractionSubmissionsBeforeSubmit).toHaveLength(0);

    await repository.submitResponse(
      session.sessionId,
      participant.participantId,
      participant.participantToken,
      "Second interaction response"
    );
    await repository.closeSubmissions(session.sessionId, session.hostToken, {
      sessionId: session.sessionId,
      eventType: "SUBMISSIONS_CLOSED",
      payload: {},
    });
    const secondReveal = await repository.revealResults(session.sessionId, session.hostToken, {
      sessionId: session.sessionId,
      eventType: "RESULTS_REVEALED",
      payload: {},
    });
    expect(secondReveal.interactionInstanceId).toBe(secondStart.interactionInstanceId);
    expect(secondReveal.state).toBe("RESULT_REVEAL");

    // Session's own state/state_version remain untouched by any of the
    // interaction-level activity above.
    const beforeComplete = await repository.getSessionById(session.sessionId);
    expect(beforeComplete?.state).toBe("LOBBY_LOCKED");
    expect(beforeComplete?.stateVersion).toBe(2);

    // COMPLETE_SESSION
    const completeResult = await repository.completeSession(session.sessionId, session.hostToken, {
      sessionId: session.sessionId,
      eventType: "SESSION_COMPLETED",
      payload: {},
    });
    expect(completeResult).toEqual({ state: "SESSION_COMPLETE", stateVersion: 3 });

    // Room-code reuse mechanism, proven live: a completed session's
    // room code is no longer resolvable as active.
    const resolvedAfterComplete = await repository.getActiveSessionByRoomCode(session.roomCode);
    expect(resolvedAfterComplete).toBeNull();
  });
});