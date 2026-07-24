// Fallback validation harness.
//
// The npm registry was unreachable in this environment when attempting to
// install vitest, so this file exercises the identical source modules
// (createSession.ts, roomCode.ts, InMemorySessionRepository) using Node's
// built-in test runner and type-stripping, so that Validated-stage
// evidence is real rather than assumed. The vitest suite at
// __tests__/createSession.test.ts is the intended long-term test file and
// should be run once package installation is possible.

import test from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../../lib/session/createSession.ts";
import { InMemorySessionRepository } from "../../lib/session/db/inMemorySessionRepository.ts";

test("creates a session with all required fields correctly populated", async () => {
  const repo = new InMemorySessionRepository();
  const result = await createSession(repo);

  assert.ok(result.sessionId);
  assert.match(result.roomCode, /^[A-Z2-9]{6}$/);
  assert.ok(result.hostToken);
  assert.equal(result.state, "LOBBY_OPEN");
  assert.equal(result.stateVersion, 1);

  const stored = await repo.getSessionById(result.sessionId);
  assert.ok(stored);
  assert.equal(stored.pauseReason, null);
  assert.equal(stored.createdAt, stored.updatedAt);
});

test("does not use visually confusable characters in the room code", async () => {
  const repo = new InMemorySessionRepository();
  const result = await createSession(repo);
  assert.doesNotMatch(result.roomCode, /[0O1IL]/);
});

test("writes an event log entry for session creation", async () => {
  const repo = new InMemorySessionRepository();
  const result = await createSession(repo);
  const events = repo._getEventsForSession(result.sessionId);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, "SESSION_CREATED");
});

test("produces two distinct, non-colliding sessions on concurrent creation", async () => {
  const repo = new InMemorySessionRepository();
  const [a, b] = await Promise.all([createSession(repo), createSession(repo)]);

  assert.notEqual(a.sessionId, b.sessionId);
  assert.notEqual(a.hostToken, b.hostToken);
  assert.notEqual(
    a.roomCode,
    b.roomCode,
    "Room code collision was not resolved by the retry mechanism."
  );
});

test("rejects a colliding room code at the repository layer", async () => {
  const repo = new InMemorySessionRepository();
  const first = await createSession(repo);

  await assert.rejects(
    () =>
      repo.insertSession({
        sessionId: "11111111-1111-1111-1111-111111111111",
        roomCode: first.roomCode,
        hostToken: "test-token-collision",
        state: "LOBBY_OPEN",
        stateVersion: 1,
        pauseReason: null,
        currentPromptId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    /Room code collision/
  );
});

test("allows room code reuse once the original session is SESSION_COMPLETE", async () => {
  const repo = new InMemorySessionRepository();
  const first = await createSession(repo);
  repo._forceComplete(first.sessionId);

  await assert.doesNotReject(() =>
    repo.insertSession({
      sessionId: "22222222-2222-2222-2222-222222222222",
      roomCode: first.roomCode,
      hostToken: "test-token-reuse",
      state: "LOBBY_OPEN",
      stateVersion: 1,
      pauseReason: null,
      currentPromptId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
  );
});

test("rejects reading a session_id that was never created", async () => {
  const repo = new InMemorySessionRepository();
  const result = await repo.getSessionById("00000000-0000-0000-0000-000000000000");
  assert.equal(result, null);
});
