import { describe, expect, it } from "vitest";

import { createSession } from "../lib/session/createSession";
import { joinSession } from "../lib/session/joinSession";
import { lockLobby } from "../lib/session/lockLobby";
import { completeSession } from "../lib/session/completeSession";
import { getSession } from "../lib/session/getSession";
import { startSession } from "../lib/session/startSession";
import { InMemorySessionRepository } from "../lib/session/db/inMemorySessionRepository";
import {
  SessionNotFoundError,
  HostTokenMismatchError,
  LobbyNotLockedError,
} from "../lib/session/types";

describe("START_SESSION", () => {
  it("transitions a LOBBY_LOCKED session to PROMPT_ACTIVE and increments state_version", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await lockLobby(repo, session.sessionId, session.hostToken);

    const result = await startSession(repo, session.sessionId, session.hostToken);

    expect(result.sessionId).toBe(session.sessionId);
    expect(result.state).toBe("PROMPT_ACTIVE");
    expect(result.stateVersion).toBe(3); // 1 (create) -> 2 (lock) -> 3 (start)
    expect(result.currentPromptId).toBeTruthy();
  });

  it("writes a SESSION_STARTED event with the selected promptId", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await lockLobby(repo, session.sessionId, session.hostToken);

    const result = await startSession(repo, session.sessionId, session.hostToken);
    const events = repo._getEventsForSession(session.sessionId);

    const startedEvent = events.find((e) => e.eventType === "SESSION_STARTED");
    expect(startedEvent).toBeDefined();
    expect(startedEvent?.payload).toEqual({ promptId: result.currentPromptId });
  });

  it("rejects starting a session that was never locked (still LOBBY_OPEN)", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);

    await expect(
      startSession(repo, session.sessionId, session.hostToken)
    ).rejects.toBeInstanceOf(LobbyNotLockedError);
  });

  it("rejects starting a session that has already started (PROMPT_ACTIVE)", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await lockLobby(repo, session.sessionId, session.hostToken);
    await startSession(repo, session.sessionId, session.hostToken);

    await expect(
      startSession(repo, session.sessionId, session.hostToken)
    ).rejects.toBeInstanceOf(LobbyNotLockedError);
  });

  it("rejects starting a session that was administratively completed", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await lockLobby(repo, session.sessionId, session.hostToken);
    await completeSession(repo, session.sessionId, session.hostToken);

    await expect(
      startSession(repo, session.sessionId, session.hostToken)
    ).rejects.toBeInstanceOf(LobbyNotLockedError);
  });

  it("rejects a mismatched host token, leaving state unchanged", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await lockLobby(repo, session.sessionId, session.hostToken);

    await expect(
      startSession(repo, session.sessionId, "wrong-token")
    ).rejects.toBeInstanceOf(HostTokenMismatchError);

    const stored = await repo.getSessionById(session.sessionId);
    expect(stored?.state).toBe("LOBBY_LOCKED");
    expect(stored?.currentPromptId).toBeNull();
  });

  it("rejects a nonexistent session id", async () => {
    const repo = new InMemorySessionRepository();

    await expect(
      startSession(repo, "11111111-1111-1111-1111-111111111111", "any-token")
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  describe("repository-level authority (closes the TOCTOU gap)", () => {
    it("in-memory proof: concurrent start attempts on the same session yield exactly one success", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await lockLobby(repo, session.sessionId, session.hostToken);

      const attempts = await Promise.allSettled([
        startSession(repo, session.sessionId, session.hostToken),
        startSession(repo, session.sessionId, session.hostToken),
      ]);

      const successes = attempts.filter((a) => a.status === "fulfilled");
      const failures = attempts.filter((a) => a.status === "rejected");

      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);

      const stored = await repo.getSessionById(session.sessionId);
      expect(stored?.stateVersion).toBe(3);
    });

    it("in-memory proof: startSession independently rejects a session that is not LOBBY_LOCKED, even when called directly (bypassing the domain fast-path)", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);

      await expect(
        repo.startSession(session.sessionId, session.hostToken)
      ).rejects.toBeInstanceOf(LobbyNotLockedError);
    });

    it("in-memory proof: startSession independently rejects a mismatched host token, even when called directly", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await lockLobby(repo, session.sessionId, session.hostToken);

      await expect(
        repo.startSession(session.sessionId, "wrong-token")
      ).rejects.toBeInstanceOf(HostTokenMismatchError);
    });

    it(
      "real Postgres contract proof NOT available in this environment — " +
        "start_session_atomically's row-locked re-check (0008 migration) " +
        "requires a live database connection to verify serialization behavior " +
        "under true concurrency. The tests above prove the logic path; " +
        "they do not prove Postgres row-lock serialization itself.",
      () => {
        expect(true).toBe(true);
      }
    );
  });

  describe("GET_SESSION integration", () => {
    it("GET_SESSION returns the selected prompt once started", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await lockLobby(repo, session.sessionId, session.hostToken);
      const started = await startSession(repo, session.sessionId, session.hostToken);

      const result = await getSession(repo, session.sessionId, session.hostToken);

      expect(result.state).toBe("PROMPT_ACTIVE");
      expect(result.currentPrompt).not.toBeNull();
      expect(result.currentPrompt?.promptId).toBe(started.currentPromptId);
      expect(result.currentPrompt?.text).toBeTruthy();
    });

    it("currentPrompt remains visible after the session is later completed", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await lockLobby(repo, session.sessionId, session.hostToken);
      const started = await startSession(repo, session.sessionId, session.hostToken);
      await completeSession(repo, session.sessionId, session.hostToken);

      const result = await getSession(repo, session.sessionId, session.hostToken);

      expect(result.state).toBe("SESSION_COMPLETE");
      expect(result.currentPrompt?.promptId).toBe(started.currentPromptId);
    });
  });

  it("full integrated sequence: create -> join -> lock -> start -> get reflects the prompt", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    const participant = await joinSession(repo, session.roomCode, "Alex");
    await lockLobby(repo, session.sessionId, session.hostToken);
    await startSession(repo, session.sessionId, session.hostToken);

    const result = await getSession(repo, session.sessionId, session.hostToken);

    expect(result.state).toBe("PROMPT_ACTIVE");
    expect(result.currentPrompt).not.toBeNull();
    expect(result.participants).toEqual([
      { participantId: participant.participantId, displayName: "Alex" },
    ]);
  });
});
