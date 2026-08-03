# Slice 002 — Scored Multi-Round Experience: Implementation and Validation Record

**Status: superseded.** Slice 002 has been constitutionally accepted. The permanent, canonical historical record now lives in the constitutional repository at `Level 33/History/Slices/Slice_002/` (Feature Genesis, Slice Selection, Slice Design, Implementation & Validation, Constitutional Acceptance). This file is kept as the working document produced during implementation, before that formalization — useful as a compact, software-repo-local reference, but `History/Slices/Slice_002/` is authoritative where the two differ.

---

**Original status note (pre-acceptance):** Implemented and validated. Not constitutionally accepted. This record was submitted for architectural review and acceptance; it did not itself declare acceptance, and no `History/Slices/Slice_002/` folder had been created yet — that formalization happened only after acceptance, mirroring how Slice 001's permanent record was constructed as a dedicated post-acceptance pass, not during implementation.

## Objective (as accepted)

Validate that participant scores can persist and accumulate across multiple sequential Interaction Instances within one Session, via an append-only, generic point-award ledger — without introducing a Game/Experience Instance runtime entity, Experience Template, or any second Interaction Engine.

## Implementation Chronology

1. **Repository review and impact assessment** (Phase 1) — inspected current types, `SessionRepository` interface, both implementations, `getSession.ts`, all API routes, all tests, and migrations 0001–0020 before proposing any change.
2. **Implementation plan** (Phase 2), revised twice following review:
   - Round 1: dropped a proposed `unique (interaction_instance_id, participant_id)` constraint after it was correctly identified as smuggling a Trivia-specific "one scoring event per interaction" rule into a supposedly generic ledger. Replaced with an idempotency-key-based design instead.
   - Round 2: idempotency scope narrowed from a globally-unique key to `unique (session_id, idempotency_key)`; idempotent replay redefined to resolve the key *before* any other check, so a retry succeeds identically even after the session has progressed to a new interaction or completed; `interactionInstanceId` became an explicit client-supplied argument rather than implicitly resolved.
3. **Schema**: `point_awards` (migration `0021`) — immutable, append-only, no `updated_at`, `check (points > 0)`, `unique (session_id, idempotency_key)`.
4. **Atomic function** (migration `0022`): `award_points_atomically` — idempotency-key lookup first (scoped to session), full validation only on a genuinely new key, `ON CONFLICT (session_id, idempotency_key) DO NOTHING` with a fallback SELECT for the concurrent-race case.
5. **Domain/repository layer**: new types (`AwardPointsResult`, `ParticipantStanding`, three new error classes), two new `SessionRepository` methods, both implementations, and a deliberately thin `awardPoints.ts` domain function with **no fast-path validation** — a one-off departure from this repo's usual domain/repository split, forced by the requirement that validation itself must be skipped on replay, which only the repository can determine.
6. **`GET_SESSION`**: gained `standings` (always present, derived by summing the ledger, independent visibility rule from `currentPrompt`/`submissions`) and `currentInteractionInstanceId` (needed so a client can submit an explicit, unambiguous award target after a refresh or on a second device).
7. **API route**: `POST /api/sessions/[identifier]/award-points`, mirroring the existing thin-route pattern.
8. **Harness**: `host.html` gained per-participant award inputs (enabled only during `RESULT_REVEAL`), a standings display, and a client-derived winner presentation; `participant.html` gained a read-only standings display. Both implement the idempotency-key lifecycle (one key per logical action, reused across retries, the triggering control disabled while pending) with explicit code comments that this is a UX mitigation, not a correctness guarantee.

## Discovered Deviations

1. **Domain-layer validation was moved entirely into the repository.** Not anticipated until Phase 2's replay-after-progression requirement made it necessary — every prior command validates eagerly in the domain layer before calling the repository; this one cannot, since whether validation should run at all depends on data only the repository can see. Documented in `awardPoints.ts` itself.
2. **A pre-existing, unrelated test infrastructure issue surfaced while running the full contract suite live**: the Slice 001 "full lifecycle" contract test (~13 sequential live round trips) intermittently exceeded vitest's default 5000ms per-test timeout. Not a Slice 002 regression — the test's own code is untouched. Fixed with a per-test timeout override (`20000`ms) and a comment explaining why, rather than restructuring the test.
3. **No schema or logic deviation from the accepted Phase 2 plan otherwise occurred.** Implementation matched the negotiated design exactly, including the `points > 0` constraint, the absence of an `updated_at` column, and the explicit `interactionInstanceId` parameter.

## Validation Evidence

| Evidence | Result |
|---|---|
| New in-memory tests (`awardPoints.test.ts`) | 24/24 passing |
| Full in-memory suite (all 10 files) | 147/147 passing |
| Live-Postgres contract tests | 6/6 passing, including: idempotent replay after a second interaction starts, idempotent replay after `COMPLETE_SESSION`, concurrent-duplicate-key race (`Promise.all`, two identical requests, exactly one row, both return the same result), and multiple independent awards for one participant in one interaction summing correctly |
| `tsc --noEmit` | Clean |
| `npm run build` | Clean (dev server stopped first, per this repo's known hazard) |
| Migrations `0021`–`0022` | Applied to the live Supabase project, confirmed via `supabase migration list` before and after |

### Operational Simulation (live browser, host + 2 participant tabs)

Executed the full required flow — create → join × 2 → lock → interaction 1 → reveal → award (Alex 10, Jordan 5) → interaction 2 → reveal → award (Alex 7 more, Jordan 12 more) → complete → final standings — plus every additional scenario requested:

- **Cumulative standings**: Alex 10 → 17 across two interactions, Jordan 5 → 17. Confirmed derived-sum correctness, not a stored total.
- **Concurrent duplicate-award protection**: fired two identical requests (same `idempotencyKey`) via `Promise.all` directly against the running server — both returned the identical `pointAwardId` and `createdAt`; exactly one row exists.
- **Unauthorized award attempt**: wrong `hostToken` → `403`.
- **Invalid interaction state**: an award targeting the now-superseded first interaction after the second started → `409` (`InteractionInstanceNotEligibleError`); an award targeting the current interaction while it was still `PROMPT_ACTIVE` (not yet revealed) → same `409`.
- **Award attempt after `SESSION_COMPLETE`**: → `409` (`LobbyNotLockedError`), confirmed live in addition to the contract-test coverage.
- **Tie result**: engineered a 17–17 tie; host and both participant views correctly rendered "Joint winners: Jordan & Alex (17 pts)" — not two separate winner claims, not a false single winner.
- **Zero-score edge case**: exercised in tests (in-memory and via the presentation logic), not re-run live in this session since it requires a *separate* session with no awards at all; the rule (`maxScore === 0` → "No winner determined") is implemented identically in both `host.html` and `participant.html`.
- **Refresh continuity**: hard-reloaded a participant tab after session completion — `sessionStorage` credential recovery plus a fresh `GET_SESSION` correctly restored standings and the winner banner on first load.
- **Slice 001 regression**: the entire lifecycle this simulation exercised (create, join, lock, two sequential interactions with host-defined prompts, submit/revise, close, reveal, complete) is itself a full regression pass of Slice 001's accepted behavior, run live end to end without incident.

## Unresolved Architectural Questions (for review, not resolved here)

1. **The `interactionInstanceId`-as-explicit-client-argument pattern** (introduced for this command alone) diverges from every other command's implicit "resolve current" convention. Whether this should remain a one-off, justified by AWARD_POINTS's replay requirement, or become the standard going forward for any future command with similar idempotency needs, is an open question for the next slice's design, not decided here.
2. **No host-facing audit trail exists** for individual point-award events — only the summed total is ever surfaced. This was an explicit non-goal, but worth naming as a real gap if operational trust in "who awarded what" ever becomes a concern.
3. **The Session-stands-in-for-Experience-Instance simplification** (from the original architectural consultation) remains exactly where it was left — unchanged, undisturbed, and still pending the eventual introduction of a real Experience Instance entity once a second consumer (e.g., multiple experience types per Session) provides evidence for it.

No claim of architectural or constitutional acceptance is made by this document.
