// Fallback validation harness for LOCK_LOBBY against the reconciled
// canonical interface. Mirrors joinSession.manual.mjs's rationale:
// exercises the real source modules via Node's built-in test runner.

import test from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../../lib/session/createSession";
import { lockLobby } from "../../lib/session/lockLobby";
import { InMemorySessionRepository } from "../../lib/session/db/inMemorySessionRepository";

test("the host can lock an open lobby", async () => {
  const repo = new InMemorySessionRepository();
  const session = await createSession(repo);
  const result = await lockLobby(repo, session.sessionId, session.hostToken);
  assert.equal(result.sessionId, session.sessionId);
  assert.equal(result.state, "LOBBY_LOCKED");
  assert.equal(result.stateVersion, session.stateVersion + 1);
});

test("rejects a mismatched host token", async () => {
  const repo = new InMemorySessionRepository();
  const session = await createSession(repo);
  await assert.rejects(() => lockLobby(repo, session.sessionId, "wrong-token"));
});

test("rejects a nonexistent session id", async () => {
  const repo = new InMemorySessionRepository();
  await assert.rejects(() =>
    lockLobby(repo, "11111111-1111-1111-1111-111111111111", "any-token")
  );
});

test("rejects locking an already-locked lobby", async () => {
  const repo = new InMemorySessionRepository();
  const session = await createSession(repo);
  await lockLobby(repo, session.sessionId, session.hostToken);
  await assert.rejects(() => lockLobby(repo, session.sessionId, session.hostToken));
});

test("repository-level authority: lockLobby rejects directly on a locked session, bypassing lockLobby's pre-check", async () => {
  const repo = new InMemorySessionRepository();
  const session = await createSession(repo);
  repo._forceState(session.sessionId, "LOBBY_LOCKED");

  const event = { sessionId: session.sessionId, eventType: "LOBBY_LOCKED", payload: {} };

  await assert.rejects(() =>
    repo.lockLobby(session.sessionId, session.hostToken, event)
  );
});

test("repository-level authority: lockLobby rejects a mismatched host token directly", async () => {
  const repo = new InMemorySessionRepository();
  const session = await createSession(repo);

  const event = { sessionId: session.sessionId, eventType: "LOBBY_LOCKED", payload: {} };

  await assert.rejects(() =>
    repo.lockLobby(session.sessionId, "wrong-token", event)
  );
});
