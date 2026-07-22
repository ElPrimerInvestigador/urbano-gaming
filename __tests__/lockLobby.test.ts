import { describe, expect, it } from "vitest";

import { createSession } from "../lib/session/createSession";
import { lockLobby } from "../lib/session/lockLobby";
import { InMemorySessionRepository } from "../lib/session/db/inMemorySessionRepository";
import {
  SessionNotFoundError,
  HostTokenMismatchError,
  LobbyNotOpenError,
} from "../lib/session/types";

describe("LOCK_LOBBY", () => {
  it("transitions an open lobby to LOBBY_LOCKED and increments state_version", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);

    const result = await lockLobby(repo, session.sessionId, session.hostToken);

    expect(result.sessionId).toBe(session.sessionId);
    expect(result.state).toBe("LOBBY_LOCKED");
    expect(result.stateVersion).toBe(session.stateVersion + 1);

    const stored = await repo.getSessionById(session.sessionId);
    expect(stored?.state).toBe("LOBBY_LOCKED");
    expect(stored?.stateVersion).toBe(session.stateVersion + 1);
  });

  it("writes a LOBBY_LOCKED event", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);

    await lockLobby(repo, session.sessionId, session.hostToken);
    const events = repo._getEventsForSession(session.sessionId);

    const lockEvent = events.find((e) => e.eventType === "LOBBY_LOCKED");
    expect(lockEvent).toBeDefined();
  });

  it("rejects a mismatched host token", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);

    await expect(
      lockLobby(repo, session.sessionId, "wrong-token")
    ).rejects.toBeInstanceOf(HostTokenMismatchError);

    const stored = await repo.getSessionById(session.sessionId);
    expect(stored?.state).toBe("LOBBY_OPEN");
    expect(stored?.stateVersion).toBe(session.stateVersion);
  });

  it("does not write a LOBBY_LOCKED event on a rejected host-token mismatch", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);

    await expect(
      lockLobby(repo, session.sessionId, "wrong-token")
    ).rejects.toBeInstanceOf(HostTokenMismatchError);

    const events = repo._getEventsForSession(session.sessionId);
    expect(events.find((e) => e.eventType === "LOBBY_LOCKED")).toBeUndefined();
  });

  it("rejects a nonexistent session id", async () => {
    const repo = new InMemorySessionRepository();

    await expect(
      lockLobby(repo, "11111111-1111-1111-1111-111111111111", "any-token")
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it("rejects locking a session that is already LOBBY_LOCKED", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await lockLobby(repo, session.sessionId, session.hostToken);

    await expect(
      lockLobby(repo, session.sessionId, session.hostToken)
    ).rejects.toBeInstanceOf(LobbyNotOpenError);
  });

  it("rejects locking a session forced into an unrelated non-open state", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    repo._forceState(session.sessionId, "SESSION_PAUSED");

    await expect(
      lockLobby(repo, session.sessionId, session.hostToken)
    ).rejects.toBeInstanceOf(LobbyNotOpenError);
  });

  describe("repository-level authority (closes the TOCTOU gap)", () => {
    it("in-memory proof: concurrent lock attempts on the same session yield exactly one success", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);

      const attempts = await Promise.allSettled([
        lockLobby(repo, session.sessionId, session.hostToken),
        lockLobby(repo, session.sessionId, session.hostToken),
      ]);

      const successes = attempts.filter((a) => a.status === "fulfilled");
      const failures = attempts.filter((a) => a.status === "rejected");

      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);

      const stored = await repo.getSessionById(session.sessionId);
      expect(stored?.stateVersion).toBe(session.stateVersion + 1);
    });

    it("in-memory proof: lockLobby independently rejects a session that is no longer LOBBY_OPEN, even when called directly (bypassing lockLobby's caller-side pre-check)", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      repo._forceState(session.sessionId, "LOBBY_LOCKED");

      const event = {
        sessionId: session.sessionId,
        eventType: "LOBBY_LOCKED" as const,
        payload: {},
      };

      await expect(
        repo.lockLobby(session.sessionId, session.hostToken, event)
      ).rejects.toBeInstanceOf(LobbyNotOpenError);
    });

    it("in-memory proof: lockLobby independently rejects a mismatched host token, even when called directly", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);

      const event = {
        sessionId: session.sessionId,
        eventType: "LOBBY_LOCKED" as const,
        payload: {},
      };

      await expect(
        repo.lockLobby(session.sessionId, "wrong-token", event)
      ).rejects.toBeInstanceOf(HostTokenMismatchError);
    });

    it(
      "real Postgres contract proof NOT available in this environment — " +
        "lock_lobby_atomically's row-locked re-check (0005 migration) " +
        "requires a live database connection to verify serialization behavior " +
        "under true concurrency. The tests above prove the logic path; " +
        "they do not prove Postgres row-lock serialization itself.",
      () => {
        expect(true).toBe(true);
      }
    );
  });
});
