// Fallback validation harness for COMPLETE_SESSION against the
// reconciled canonical interface. Mirrors lockLobby.manual.mjs's
// rationale: exercises the real source modules via Node's built-in
// test runner.

import test from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../../lib/session/createSession";
import { joinSession } from "../../lib/session/joinSession";
import { completeSession } from "../../lib/session/completeSession";
import { InMemorySessionRepository } from "../../lib/session/db/inMemorySessionRepository";

test("the host can complete a LOBBY_OPEN session", async () => {
  const repo = new InMemorySessionRepository();
  const session = await createSession(repo);
  const result = await completeSession(repo, session.sessionId, session.hostToken);
  assert.equal(result.state, "SESSION_COMPLETE");
  assert.equal(result.stateVersion, session.stateVersion + 1);
});

test("rejects a mismatched host token", async () => {
  const repo = new InMemorySessionRepository();
  const session = await createSession(repo);
  await assert.rejects(() =>
    completeSession(repo, session.sessionId, "wrong-token")
  );
});

test("rejects completing an already-complete session", async () => {
  const repo = new InMemorySessionRepository();
  const session = await createSession(repo);
  await completeSession(repo, session.sessionId, session.hostToken);
  await assert.rejects(() =>
    completeSession(repo, session.sessionId, session.hostToken)
  );
});

test("rejects a nonexistent session id", async () => {
  const repo = new InMemorySessionRepository();
  await assert.rejects(() =>
    completeSession(repo, "11111111-1111-1111-1111-111111111111", "any-token")
  );
});

test("room-code reuse works through the real command, no test backdoor", async () => {
  const repo = new InMemorySessionRepository();
  const first = await createSession(repo);
  await completeSession(repo, first.sessionId, first.hostToken);

  const activeMatch = await repo.getActiveSessionByRoomCode(first.roomCode);
  assert.equal(activeMatch, null);
  await assert.rejects(() => joinSession(repo, first.roomCode, "TooLate"));
});
