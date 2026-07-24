// Fallback validation harness for START_SESSION against the reconciled
// canonical interface. Mirrors lockLobby.manual.mjs's rationale:
// exercises the real source modules via Node's built-in test runner.

import test from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../../lib/session/createSession";
import { lockLobby } from "../../lib/session/lockLobby";
import { startSession } from "../../lib/session/startSession";
import { getSession } from "../../lib/session/getSession";
import { InMemorySessionRepository } from "../../lib/session/db/inMemorySessionRepository";

test("the host can start a LOBBY_LOCKED session", async () => {
  const repo = new InMemorySessionRepository();
  const session = await createSession(repo);
  await lockLobby(repo, session.sessionId, session.hostToken);
  const result = await startSession(repo, session.sessionId, session.hostToken);
  assert.equal(result.state, "PROMPT_ACTIVE");
  assert.ok(result.currentPromptId);
});

test("rejects starting a session that was never locked", async () => {
  const repo = new InMemorySessionRepository();
  const session = await createSession(repo);
  await assert.rejects(() => startSession(repo, session.sessionId, session.hostToken));
});

test("rejects a mismatched host token", async () => {
  const repo = new InMemorySessionRepository();
  const session = await createSession(repo);
  await lockLobby(repo, session.sessionId, session.hostToken);
  await assert.rejects(() => startSession(repo, session.sessionId, "wrong-token"));
});

test("rejects a nonexistent session id", async () => {
  const repo = new InMemorySessionRepository();
  await assert.rejects(() =>
    startSession(repo, "11111111-1111-1111-1111-111111111111", "any-token")
  );
});

test("GET_SESSION reflects the selected prompt after starting", async () => {
  const repo = new InMemorySessionRepository();
  const session = await createSession(repo);
  await lockLobby(repo, session.sessionId, session.hostToken);
  await startSession(repo, session.sessionId, session.hostToken);
  const result = await getSession(repo, session.sessionId, session.hostToken);
  assert.equal(result.state, "PROMPT_ACTIVE");
  assert.ok(result.currentPrompt);
  assert.ok(result.currentPrompt.text);
});
