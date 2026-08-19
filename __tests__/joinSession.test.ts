import { describe, expect, it } from "vitest";

import { createSession } from "../lib/session/createSession";
import { joinSession } from "../lib/session/joinSession";
import { InMemorySessionRepository } from "../lib/session/db/inMemorySessionRepository";
import {
  DisplayNameTakenError,
  SessionNotFoundError,
  LobbyNotOpenError,
  EmptyDisplayNameError,
  DisplayNameTooLongError,
} from "../lib/session/types";

describe("JOIN_SESSION", () => {
  it("allows a participant to join an active LOBBY_OPEN session", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);

    const result = await joinSession(repo, session.roomCode, "Alex");

    expect(result.participantId).toBeTruthy();
    expect(result.participantToken).toBeTruthy();
    expect(result.sessionId).toBe(session.sessionId);
    expect(result.sessionState).toBe("LOBBY_OPEN");
    expect(result.displayName).toBe("Alex");
  });

  it("writes a PARTICIPANT_JOINED event on join", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);

    const result = await joinSession(repo, session.roomCode, "Jordan");
    const events = repo._getEventsForSession(session.sessionId);

    const joinEvent = events.find((e) => e.eventType === "PARTICIPANT_JOINED");
    expect(joinEvent).toBeDefined();
    expect(joinEvent?.payload).toEqual({
      participantId: result.participantId,
      displayName: "Jordan",
    });
  });

  it("rejects a duplicate normalized display name within the same session", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);

    await joinSession(repo, session.roomCode, "Sam");

    await expect(
      joinSession(repo, session.roomCode, "  sam  ")
    ).rejects.toBeInstanceOf(DisplayNameTakenError);
  });

  it("does NOT return the original participant on a repeated request with the same name — this is explicit MVP behavior, not idempotent retry", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);

    const first = await joinSession(repo, session.roomCode, "Riley");

    let secondAttemptError: unknown;
    try {
      await joinSession(repo, session.roomCode, "Riley");
    } catch (err) {
      secondAttemptError = err;
    }

    expect(secondAttemptError).toBeInstanceOf(DisplayNameTakenError);
    // Confirm no second participant record exists, and the original is untouched.
    const participants = repo._allParticipants();
    expect(participants).toHaveLength(1);
    expect(participants[0].participantId).toBe(first.participantId);
  });

  it("allows the same display name in two different sessions", async () => {
    const repo = new InMemorySessionRepository();
    const sessionA = await createSession(repo);
    const sessionB = await createSession(repo);

    const a = await joinSession(repo, sessionA.roomCode, "Casey");
    const b = await joinSession(repo, sessionB.roomCode, "Casey");

    expect(a.participantId).not.toBe(b.participantId);
  });

  it("rejects joining a nonexistent room code", async () => {
    const repo = new InMemorySessionRepository();

    await expect(
      joinSession(repo, "ZZZZZZ", "Anyone")
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  describe("room code normalization", () => {
    it("accepts a lowercase version of the room code", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);

      const result = await joinSession(
        repo,
        session.roomCode.toLowerCase(),
        "Taylor"
      );

      expect(result.sessionId).toBe(session.sessionId);
    });

    it("accepts a room code with leading/trailing whitespace", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);

      const result = await joinSession(
        repo,
        `  ${session.roomCode}  `,
        "Jamie"
      );

      expect(result.sessionId).toBe(session.sessionId);
    });

    it("accepts a room code that is both mixed-case and padded", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      const mangled = ` ${session.roomCode.toLowerCase()} `;

      const result = await joinSession(repo, mangled, "Robin");

      expect(result.sessionId).toBe(session.sessionId);
    });
  });

  it("rejects joining a session that is not LOBBY_OPEN (application-layer pre-check)", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    repo._forceState(session.sessionId, "LOBBY_LOCKED");

    await expect(
      joinSession(repo, session.roomCode, "Late")
    ).rejects.toBeInstanceOf(LobbyNotOpenError);
  });

  it("does not persist a participant or event when the session is not joinable", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    repo._forceState(session.sessionId, "SESSION_PAUSED");

    await expect(joinSession(repo, session.roomCode, "Blocked")).rejects.toThrow();

    expect(repo._allParticipants()).toHaveLength(0);
    const events = repo._getEventsForSession(session.sessionId);
    expect(events.find((e) => e.eventType === "PARTICIPANT_JOINED")).toBeUndefined();
  });

  describe("display-name validation floor", () => {
    it("rejects a display name that is empty after trimming", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);

      await expect(
        joinSession(repo, session.roomCode, "   ")
      ).rejects.toBeInstanceOf(EmptyDisplayNameError);
    });

    it("rejects a display name that is empty after trimming without touching the repository", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);

      await expect(joinSession(repo, session.roomCode, "")).rejects.toBeInstanceOf(
        EmptyDisplayNameError
      );
      expect(repo._allParticipants()).toHaveLength(0);
    });

    it("rejects a display name exceeding 40 characters after trimming", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      const tooLong = "A".repeat(41);

      await expect(
        joinSession(repo, session.roomCode, tooLong)
      ).rejects.toBeInstanceOf(DisplayNameTooLongError);
    });

    it("accepts a display name of exactly 40 characters after trimming", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      const exactly40 = "B".repeat(40);

      const result = await joinSession(repo, session.roomCode, exactly40);
      expect(result.displayName).toBe(exactly40);
    });

    it("preserves the trimmed display name for presentation while normalizing to lowercase for uniqueness", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);

      const result = await joinSession(repo, session.roomCode, "  Dana  ");
      expect(result.displayName).toBe("Dana");

      // A different-cased, differently-padded version of the same name
      // should now collide, proving normalization is trim + lowercase.
      await expect(
        joinSession(repo, session.roomCode, "dana")
      ).rejects.toBeInstanceOf(DisplayNameTakenError);
    });

    it("allows Unicode and emoji display names within the length rule", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);

      const result = await joinSession(repo, session.roomCode, "José 🎉");
      expect(result.displayName).toBe("José 🎉");
    });
  });

  describe("repository-level session-state authority (closes the TOCTOU gap)", () => {
    it("in-memory proof: joinParticipant independently rejects a session that is no longer LOBBY_OPEN, even if called directly (bypassing joinSession's pre-check)", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);

      // Simulate the race: state changes after an application-layer lookup
      // would have already passed, then the persistence call happens.
      repo._forceState(session.sessionId, "LOBBY_LOCKED");

      const record = {
        participantId: "11111111-1111-1111-1111-111111111111",
        sessionId: session.sessionId,
        displayName: "Race",
        normalizedDisplayName: "race",
        participantToken: "test-token",
        joinedAt: new Date().toISOString(),
        gamingMemberId: null,
      };
      const event = {
        sessionId: session.sessionId,
        eventType: "PARTICIPANT_JOINED" as const,
        payload: { participantId: record.participantId, displayName: "Race" },
      };

      await expect(repo.joinParticipant(record, event)).rejects.toBeInstanceOf(
        LobbyNotOpenError
      );
      expect(repo._allParticipants()).toHaveLength(0);
    });

    it("in-memory proof: joinParticipant rejects a session_id that does not exist, independent of any caller-side lookup", async () => {
      const repo = new InMemorySessionRepository();

      const record = {
        participantId: "22222222-2222-2222-2222-222222222222",
        sessionId: "33333333-3333-3333-3333-333333333333",
        displayName: "Ghost",
        normalizedDisplayName: "ghost",
        participantToken: "test-token-2",
        joinedAt: new Date().toISOString(),
        gamingMemberId: null,
      };
      const event = {
        sessionId: "33333333-3333-3333-3333-333333333333",
        eventType: "PARTICIPANT_JOINED" as const,
        payload: { participantId: record.participantId, displayName: "Ghost" },
      };

      await expect(repo.joinParticipant(record, event)).rejects.toBeInstanceOf(
        SessionNotFoundError
      );
    });

    it(
      "real Postgres contract proof NOT available in this environment — " +
        "join_participant_atomically's row-locked re-check (0004 migration) " +
        "requires a live database connection to verify serialization behavior " +
        "under true concurrency. The two tests above prove the logic path; " +
        "they do not prove Postgres row-lock serialization itself.",
      () => {
        expect(true).toBe(true);
      }
    );
  });
});

