// Fallback validation harness for JOIN_SESSION against the reconciled
// canonical interface. Mirrors createSession.manual.mjs's rationale:
// exercises the real source modules via Node's built-in test runner.

import test from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../../lib/session/createSession";
import { joinSession } from "../../lib/session/joinSession";
import { InMemorySessionRepository } from "../../lib/session/db/inMemorySessionRepository";

test("a participant can join an active LOBBY_OPEN session", async () => {
  const repo = new InMemorySessionRepository();
  const session = await createSession(repo);
  const result = await joinSession(repo, session.roomCode, "Alex");
  assert.ok(result.participantId);
  assert.ok(result.participantToken);
  assert.equal(result.sessionId, session.sessionId);
  assert.equal(result.displayName, "Alex");
});

test("rejects a duplicate normalized display name (case/whitespace-insensitive)", async () => {
  const repo = new InMemorySessionRepository();
  const session = await createSession(repo);
  await joinSession(repo, session.roomCode, "Sam");
  await assert.rejects(() => joinSession(repo, session.roomCode, "  SAM  "));
});

test("repeated identical request is rejected, not idempotently returned", async () => {
  const repo = new InMemorySessionRepository();
  const session = await createSession(repo);
  const first = await joinSession(repo, session.roomCode, "Riley");
  await assert.rejects(() => joinSession(repo, session.roomCode, "Riley"));
  const participants = repo._allParticipants();
  assert.equal(participants.length, 1);
  assert.equal(participants[0].participantId, first.participantId);
});

test("rejects joining a nonexistent room code", async () => {
  const repo = new InMemorySessionRepository();
  await assert.rejects(() => joinSession(repo, "ZZZZZZ", "Anyone"));
});

test("rejects joining a session that is not LOBBY_OPEN", async () => {
  const repo = new InMemorySessionRepository();
  const session = await createSession(repo);
  repo._forceState(session.sessionId, "LOBBY_LOCKED");
  await assert.rejects(() => joinSession(repo, session.roomCode, "Late"));
});

test("rejects empty-after-trim display name without touching the repository", async () => {
  const repo = new InMemorySessionRepository();
  const session = await createSession(repo);
  await assert.rejects(() => joinSession(repo, session.roomCode, "   "));
  assert.equal(repo._allParticipants().length, 0);
});

test("rejects display name over 40 chars after trim", async () => {
  const repo = new InMemorySessionRepository();
  const session = await createSession(repo);
  await assert.rejects(() => joinSession(repo, session.roomCode, "A".repeat(41)));
});

test("accepts exactly 40 chars after trim", async () => {
  const repo = new InMemorySessionRepository();
  const session = await createSession(repo);
  const result = await joinSession(repo, session.roomCode, "B".repeat(40));
  assert.equal(result.displayName, "B".repeat(40));
});

test("allows unicode/emoji names", async () => {
  const repo = new InMemorySessionRepository();
  const session = await createSession(repo);
  const result = await joinSession(repo, session.roomCode, "José 🎉");
  assert.equal(result.displayName, "José 🎉");
});

test("repository-level authority: joinParticipant rejects directly on a locked session, bypassing joinSession's pre-check", async () => {
  const repo = new InMemorySessionRepository();
  const session = await createSession(repo);
  repo._forceState(session.sessionId, "LOBBY_LOCKED");

  const record = {
    participantId: "11111111-1111-1111-1111-111111111111",
    sessionId: session.sessionId,
    displayName: "Race",
    normalizedDisplayName: "race",
    participantToken: "test-token",
    joinedAt: new Date().toISOString(),
  };
  const event = {
    sessionId: session.sessionId,
    eventType: "PARTICIPANT_JOINED",
    payload: { participantId: record.participantId, displayName: "Race" },
  };

  await assert.rejects(() => repo.joinParticipant(record, event));
  assert.equal(repo._allParticipants().length, 0);
});

test("repository-level authority: joinParticipant rejects a nonexistent session_id directly", async () => {
  const repo = new InMemorySessionRepository();
  const record = {
    participantId: "22222222-2222-2222-2222-222222222222",
    sessionId: "33333333-3333-3333-3333-333333333333",
    displayName: "Ghost",
    normalizedDisplayName: "ghost",
    participantToken: "test-token-2",
    joinedAt: new Date().toISOString(),
  };
  const event = {
    sessionId: "33333333-3333-3333-3333-333333333333",
    eventType: "PARTICIPANT_JOINED",
    payload: { participantId: record.participantId, displayName: "Ghost" },
  };
  await assert.rejects(() => repo.joinParticipant(record, event));
});
