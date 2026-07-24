// Fallback validation harness for CLOSE_SUBMISSIONS. Mirrors
// startSession.manual.mjs's rationale.

import test from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../../lib/session/createSession";
import { joinSession } from "../../lib/session/joinSession";
import { lockLobby } from "../../lib/session/lockLobby";
import { startSession } from "../../lib/session/startSession";
import { closeSubmissions } from "../../lib/session/closeSubmissions";
import { InMemorySessionRepository } from "../../lib/session/db/inMemorySessionRepository";

test("the host can close submissions during PROMPT_ACTIVE", async () => {
  const repo = new InMemorySessionRepository();
  const session = await createSession(repo);
  await joinSession(repo, session.roomCode, "Alex");
  await lockLobby(repo, session.sessionId, session.hostToken);
  await startSession(repo, session.sessionId, session.hostToken);
  const result = await closeSubmissions(repo, session.sessionId, session.hostToken);
  assert.equal(result.state, "SUBMISSIONS_CLOSED");
});

test("rejects a mismatched host token", async () => {
  const repo = new InMemorySessionRepository();
  const session = await createSession(repo);
  await lockLobby(repo, session.sessionId, session.hostToken);
  await startSession(repo, session.sessionId, session.hostToken);
  await assert.rejects(() => closeSubmissions(repo, session.sessionId, "wrong-token"));
});
