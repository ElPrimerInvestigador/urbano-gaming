import { describe, expect, it } from "vitest";

import { createSession } from "../lib/session/createSession";
import { joinSession } from "../lib/session/joinSession";
import { lockLobby } from "../lib/session/lockLobby";
import { getSession } from "../lib/session/getSession";
import { InMemorySessionRepository } from "../lib/session/db/inMemorySessionRepository";
import {
  SessionNotFoundError,
  SessionAccessDeniedError,
} from "../lib/session/types";

describe("GET_SESSION", () => {
  it("returns session state, state_version, and an empty participant list for a fresh session, when authorized as host", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);

    const result = await getSession(repo, session.sessionId, session.hostToken);

    expect(result.sessionId).toBe(session.sessionId);
    expect(result.state).toBe("LOBBY_OPEN");
    expect(result.stateVersion).toBe(1);
    expect(result.participants).toEqual([]);
  });

  it("returns the participant list with display names, ordered by join time, and no tokens", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    const alex = await joinSession(repo, session.roomCode, "Alex");
    const jordan = await joinSession(repo, session.roomCode, "Jordan");

    const result = await getSession(repo, session.sessionId, session.hostToken);

    expect(result.participants).toEqual([
      { participantId: alex.participantId, displayName: "Alex" },
      { participantId: jordan.participantId, displayName: "Jordan" },
    ]);
    for (const participant of result.participants) {
      expect(participant).not.toHaveProperty("participantToken");
    }
  });

  it("does not include hostToken anywhere in the result", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);

    const result = await getSession(repo, session.sessionId, session.hostToken);

    expect(result).not.toHaveProperty("hostToken");
    expect(JSON.stringify(result)).not.toContain(session.hostToken);
  });

  it("authorizes a participant using their own participant token", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    const participant = await joinSession(repo, session.roomCode, "Riley");

    const result = await getSession(
      repo,
      session.sessionId,
      participant.participantToken
    );

    expect(result.sessionId).toBe(session.sessionId);
  });

  it("rejects a token that matches neither the host nor any participant", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await joinSession(repo, session.roomCode, "Casey");

    await expect(
      getSession(repo, session.sessionId, "some-unrelated-token")
    ).rejects.toBeInstanceOf(SessionAccessDeniedError);
  });

  it("rejects a participant's token scoped to a different session", async () => {
    const repo = new InMemorySessionRepository();
    const sessionA = await createSession(repo);
    const sessionB = await createSession(repo);
    const participantOfA = await joinSession(repo, sessionA.roomCode, "Morgan");

    await expect(
      getSession(repo, sessionB.sessionId, participantOfA.participantToken)
    ).rejects.toBeInstanceOf(SessionAccessDeniedError);
  });

  it("rejects a nonexistent session id", async () => {
    const repo = new InMemorySessionRepository();

    await expect(
      getSession(repo, "11111111-1111-1111-1111-111111111111", "any-token")
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it("reflects state changes after LOCK_LOBBY", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await lockLobby(repo, session.sessionId, session.hostToken);

    const result = await getSession(repo, session.sessionId, session.hostToken);

    expect(result.state).toBe("LOBBY_LOCKED");
    expect(result.stateVersion).toBe(2);
  });

  it("still authorizes a participant who joined before the lobby was locked", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    const participant = await joinSession(repo, session.roomCode, "Drew");
    await lockLobby(repo, session.sessionId, session.hostToken);

    const result = await getSession(
      repo,
      session.sessionId,
      participant.participantToken
    );

    expect(result.state).toBe("LOBBY_LOCKED");
    expect(result.participants).toHaveLength(1);
  });
});
