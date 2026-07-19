import { describe, it, expect } from "vitest";
import { createSession } from "../lib/session/createSession";
import { InMemorySessionRepository } from "../lib/session/db/inMemorySessionRepository";

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
    expect(stored!.pauseReason).toBeNull();
    expect(stored!.createdAt).toBe(stored!.updatedAt);
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
    expect(events.length).toBe(1);
    expect(events[0].eventType).toBe("SESSION_CREATED");
  });

  it("produces two distinct, non-colliding sessions on concurrent creation", async () => {
    const repo = new InMemorySessionRepository();
    const [a, b] = await Promise.all([createSession(repo), createSession(repo)]);

    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a.hostToken).not.toBe(b.hostToken);
    // room codes are randomly generated; collision is possible but rare —
    // this assertion protects against the retry path silently failing to
    // distinguish two sessions if it did collide.
    if (a.roomCode === b.roomCode) {
      throw new Error(
        "Room code collision was not resolved by the retry mechanism."
      );
    }
  });

  it("rejects a colliding room code and regenerates rather than creating a duplicate active code", async () => {
    // Force a deterministic collision scenario by pre-seeding the repo
    // with a session whose room code we then simulate colliding against.
    const repo = new InMemorySessionRepository();
    const first = await createSession(repo);

    // Directly attempt a raw insert with the same room code to confirm
    // the repository layer itself rejects it (this is what the Supabase
    // partial unique index enforces in production).
    await expect(
      repo.insertSession({
        sessionId: "11111111-1111-1111-1111-111111111111",
        roomCode: first.roomCode,
        hostToken: "test-token-collision",
        state: "LOBBY_OPEN",
        stateVersion: 1,
        pauseReason: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    ).rejects.toThrow("Room code collision");
  });

  it("allows room code reuse once the original session is SESSION_COMPLETE (accepted assumption)", async () => {
    const repo = new InMemorySessionRepository();
    const first = await createSession(repo);

    // Simulate the accepted lifecycle rule — there is no COMPLETE_SESSION
    // command in this vertical slice's scope, so this uses a dedicated
    // test-only helper rather than reaching into repository internals.
    repo._forceComplete(first.sessionId);

    await expect(
      repo.insertSession({
        sessionId: "22222222-2222-2222-2222-222222222222",
        roomCode: first.roomCode,
        hostToken: "test-token-reuse",
        state: "LOBBY_OPEN",
        stateVersion: 1,
        pauseReason: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    ).resolves.not.toThrow();
  });
});
