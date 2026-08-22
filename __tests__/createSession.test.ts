import { describe, expect, it } from "vitest";

import { createSession } from "../lib/session/createSession";
import { InMemorySessionRepository } from "../lib/session/db/inMemorySessionRepository";
import { RoomCodeCollisionError } from "../lib/session/types";

describe("CREATE_SESSION", () => {
  it("creates a session with all required fields correctly populated", async () => {
    const repo = new InMemorySessionRepository();
    const result = await createSession(repo);

    expect(result.sessionId).toBeTruthy();
    expect(result.roomCode).toMatch(/^[A-Z2-9]{6}$/);
    expect(result.hostToken).toBeTruthy();
    expect(result.state).toBe("LOBBY_OPEN");
    expect(result.stateVersion).toBe(1);

    const stored = await repo.getSessionById(result.sessionId);

    expect(stored).not.toBeNull();
    expect(stored?.pauseReason).toBeNull();
    expect(stored?.createdAt).toBe(stored?.updatedAt);
  });

  it("does not use visually confusable characters in the room code", async () => {
    const repo = new InMemorySessionRepository();
    const result = await createSession(repo);

    expect(result.roomCode).not.toMatch(/[0O1IL]/);
  });

  it("writes an event log entry for session creation", async () => {
    const repo = new InMemorySessionRepository();
    const result = await createSession(repo);
    const events = repo._getEventsForSession(result.sessionId);

    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("SESSION_CREATED");
    expect(events[0].sessionId).toBe(result.sessionId);
    expect(events[0].payload).toEqual({
      roomCode: result.roomCode,
    });
  });

  it("produces two distinct, non-colliding sessions on concurrent creation", async () => {
    const repo = new InMemorySessionRepository();

    const [first, second] = await Promise.all([
      createSession(repo),
      createSession(repo),
    ]);

    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.hostToken).not.toBe(second.hostToken);
    expect(first.roomCode).not.toBe(second.roomCode);
  });

  it("rejects a duplicate active room code", async () => {
    const repo = new InMemorySessionRepository();
    const first = await createSession(repo);

    const duplicateSessionId =
      "11111111-1111-1111-1111-111111111111";
    const now = new Date().toISOString();

    await expect(
      repo.createSession(
        {
          sessionId: duplicateSessionId,
          roomCode: first.roomCode,
          hostToken: "host-token-collision-fixture",
          state: "LOBBY_OPEN",
          stateVersion: 1,
          pauseReason: null,
          currentPromptId: null,
          predecessorSessionId: null,
          createdAt: now,
          updatedAt: now,
          declaredCapabilities: [],
        },
        {
          sessionId: duplicateSessionId,
          eventType: "SESSION_CREATED",
          payload: {
            roomCode: first.roomCode,
          },
        }
      )
    ).rejects.toBeInstanceOf(RoomCodeCollisionError);

    const storedDuplicate = await repo.getSessionById(duplicateSessionId);
    const duplicateEvents = repo._getEventsForSession(duplicateSessionId);

    expect(storedDuplicate).toBeNull();
    expect(duplicateEvents).toHaveLength(0);
  });

  it("allows room code reuse once the original session is SESSION_COMPLETE", async () => {
    const repo = new InMemorySessionRepository();
    const first = await createSession(repo);

    repo._forceComplete(first.sessionId);

    const reusedSessionId =
      "22222222-2222-2222-2222-222222222222";
    const now = new Date().toISOString();

    await expect(
      repo.createSession(
        {
          sessionId: reusedSessionId,
          roomCode: first.roomCode,
          hostToken: "host-token-reuse-fixture",
          state: "LOBBY_OPEN",
          stateVersion: 1,
          pauseReason: null,
          currentPromptId: null,
          predecessorSessionId: null,
          createdAt: now,
          updatedAt: now,
          declaredCapabilities: [],
        },
        {
          sessionId: reusedSessionId,
          eventType: "SESSION_CREATED",
          payload: {
            roomCode: first.roomCode,
          },
        }
      )
    ).resolves.toBeUndefined();

    const stored = await repo.getSessionById(reusedSessionId);
    const events = repo._getEventsForSession(reusedSessionId);

    expect(stored).not.toBeNull();
    expect(stored?.roomCode).toBe(first.roomCode);
    expect(stored?.state).toBe("LOBBY_OPEN");

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      sessionId: reusedSessionId,
      eventType: "SESSION_CREATED",
      payload: {
        roomCode: first.roomCode,
      },
    });
  });
});