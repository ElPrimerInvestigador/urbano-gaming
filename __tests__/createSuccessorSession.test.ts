import { describe, expect, it } from "vitest";

import { createSession } from "../lib/session/createSession";
import { createSuccessorSession } from "../lib/session/createSuccessorSession";
import { completeSession } from "../lib/session/completeSession";
import { lockLobby } from "../lib/session/lockLobby";
import { InMemorySessionRepository } from "../lib/session/db/inMemorySessionRepository";
import {
  SessionNotFoundError,
  HostTokenMismatchError,
  PredecessorSessionNotCompleteError,
  PredecessorAlreadyHasSuccessorError,
} from "../lib/session/types";

describe("CREATE_SUCCESSOR_SESSION", () => {
  it("creates a fresh, independent session with predecessorSessionId set", async () => {
    const repo = new InMemorySessionRepository();
    const predecessor = await createSession(repo);
    await completeSession(repo, predecessor.sessionId, predecessor.hostToken);

    const successor = await createSuccessorSession(
      repo,
      predecessor.sessionId,
      predecessor.hostToken
    );

    expect(successor.sessionId).not.toBe(predecessor.sessionId);
    expect(successor.roomCode).not.toBe(predecessor.roomCode);
    expect(successor.hostToken).not.toBe(predecessor.hostToken);
    expect(successor.state).toBe("LOBBY_OPEN");
    expect(successor.stateVersion).toBe(1);

    const stored = await repo.getSessionById(successor.sessionId);
    expect(stored?.predecessorSessionId).toBe(predecessor.sessionId);
  });

  it("does not mutate the predecessor session at all", async () => {
    const repo = new InMemorySessionRepository();
    const predecessor = await createSession(repo);
    await completeSession(repo, predecessor.sessionId, predecessor.hostToken);
    const before = await repo.getSessionById(predecessor.sessionId);

    await createSuccessorSession(repo, predecessor.sessionId, predecessor.hostToken);

    const after = await repo.getSessionById(predecessor.sessionId);
    expect(after).toEqual(before);
  });

  it("writes a SESSION_CREATED event carrying predecessorSessionId in its payload", async () => {
    const repo = new InMemorySessionRepository();
    const predecessor = await createSession(repo);
    await completeSession(repo, predecessor.sessionId, predecessor.hostToken);

    const successor = await createSuccessorSession(
      repo,
      predecessor.sessionId,
      predecessor.hostToken
    );
    const events = repo._getEventsForSession(successor.sessionId);

    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("SESSION_CREATED");
    expect(events[0].payload).toEqual({
      roomCode: successor.roomCode,
      predecessorSessionId: predecessor.sessionId,
    });
  });

  it("copies no participants, questions, or scores from the predecessor", async () => {
    const repo = new InMemorySessionRepository();
    const predecessor = await createSession(repo);
    await completeSession(repo, predecessor.sessionId, predecessor.hostToken);

    const successor = await createSuccessorSession(
      repo,
      predecessor.sessionId,
      predecessor.hostToken
    );

    expect(await repo.getParticipantsForSession(successor.sessionId)).toEqual([]);
    expect(await repo.getPreparedQuestionsForSession(successor.sessionId)).toEqual([]);
    expect(await repo.getPointAwardsForSession(successor.sessionId)).toEqual([]);
  });

  it("rejects a nonexistent predecessor session id", async () => {
    const repo = new InMemorySessionRepository();

    await expect(
      createSuccessorSession(
        repo,
        "11111111-1111-1111-1111-111111111111",
        "any-token"
      )
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it("rejects a mismatched host token, leaving no successor created", async () => {
    const repo = new InMemorySessionRepository();
    const predecessor = await createSession(repo);
    await completeSession(repo, predecessor.sessionId, predecessor.hostToken);

    await expect(
      createSuccessorSession(repo, predecessor.sessionId, "wrong-token")
    ).rejects.toBeInstanceOf(HostTokenMismatchError);

    expect(
      await repo.getSuccessorSessionByPredecessorId(predecessor.sessionId)
    ).toBeNull();
  });

  it("rejects a predecessor that is still LOBBY_OPEN", async () => {
    const repo = new InMemorySessionRepository();
    const predecessor = await createSession(repo);

    await expect(
      createSuccessorSession(repo, predecessor.sessionId, predecessor.hostToken)
    ).rejects.toBeInstanceOf(PredecessorSessionNotCompleteError);
  });

  it("rejects a predecessor that is LOBBY_LOCKED but not yet complete", async () => {
    const repo = new InMemorySessionRepository();
    const predecessor = await createSession(repo);
    await lockLobby(repo, predecessor.sessionId, predecessor.hostToken);

    await expect(
      createSuccessorSession(repo, predecessor.sessionId, predecessor.hostToken)
    ).rejects.toBeInstanceOf(PredecessorSessionNotCompleteError);
  });

  it("rejects a second successor for the same predecessor (fast-path check)", async () => {
    const repo = new InMemorySessionRepository();
    const predecessor = await createSession(repo);
    await completeSession(repo, predecessor.sessionId, predecessor.hostToken);
    await createSuccessorSession(repo, predecessor.sessionId, predecessor.hostToken);

    await expect(
      createSuccessorSession(repo, predecessor.sessionId, predecessor.hostToken)
    ).rejects.toBeInstanceOf(PredecessorAlreadyHasSuccessorError);
  });

  it("rejects a second successor even when the fast-path check is bypassed (repository-level authority)", async () => {
    const repo = new InMemorySessionRepository();
    const predecessor = await createSession(repo);
    await completeSession(repo, predecessor.sessionId, predecessor.hostToken);
    const firstSuccessor = await createSuccessorSession(
      repo,
      predecessor.sessionId,
      predecessor.hostToken
    );

    const now = new Date().toISOString();
    await expect(
      repo.createSession(
        {
          sessionId: "33333333-3333-3333-3333-333333333333",
          roomCode: "ZZZZZZ",
          hostToken: "second-successor-fixture-host-token",
          state: "LOBBY_OPEN",
          stateVersion: 1,
          pauseReason: null,
          currentPromptId: null,
          predecessorSessionId: predecessor.sessionId,
          createdAt: now,
          updatedAt: now,
          declaredCapabilities: [],
        },
        {
          sessionId: "33333333-3333-3333-3333-333333333333",
          eventType: "SESSION_CREATED",
          payload: { roomCode: "ZZZZZZ", predecessorSessionId: predecessor.sessionId },
        }
      )
    ).rejects.toBeInstanceOf(PredecessorAlreadyHasSuccessorError);

    // The first, legitimate successor is unaffected.
    expect(
      (await repo.getSuccessorSessionByPredecessorId(predecessor.sessionId))?.sessionId
    ).toBe(firstSuccessor.sessionId);
  });

  it("supports a chain: a successor can itself become a predecessor once it completes (A -> B -> C)", async () => {
    const repo = new InMemorySessionRepository();
    const sessionA = await createSession(repo);
    await completeSession(repo, sessionA.sessionId, sessionA.hostToken);

    const sessionB = await createSuccessorSession(
      repo,
      sessionA.sessionId,
      sessionA.hostToken
    );
    await completeSession(repo, sessionB.sessionId, sessionB.hostToken);

    const sessionC = await createSuccessorSession(
      repo,
      sessionB.sessionId,
      sessionB.hostToken
    );

    const storedB = await repo.getSessionById(sessionB.sessionId);
    const storedC = await repo.getSessionById(sessionC.sessionId);
    expect(storedB?.predecessorSessionId).toBe(sessionA.sessionId);
    expect(storedC?.predecessorSessionId).toBe(sessionB.sessionId);

    // A's successor is B, not C — each link only ever constrains its
    // own immediate predecessor.
    expect(
      (await repo.getSuccessorSessionByPredecessorId(sessionA.sessionId))?.sessionId
    ).toBe(sessionB.sessionId);
    expect(
      (await repo.getSuccessorSessionByPredecessorId(sessionB.sessionId))?.sessionId
    ).toBe(sessionC.sessionId);
  });
});
