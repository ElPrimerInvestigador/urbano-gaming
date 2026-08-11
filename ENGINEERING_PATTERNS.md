# Engineering Patterns

Reusable, code-level patterns discovered during implementation of
Slices 001–006 — not one-time details of any single slice, but shapes
a future engine or slice's design phase should start from rather than
re-derive. This document is implementation-tier, not constitutional:
it explains *how* to build consistent with the accepted architecture,
not *why* the architecture is shaped the way it is (that's the
Architecture Decision Record in the constitutional repository).

An entry only belongs here once it's actually been validated — either
by being explicitly flagged in a slice's own record as worth reusing,
or by being independently reached for the same reason more than once.
A pattern used exactly once, with no such signal, stays in that
slice's implementation record instead of being promoted here
prematurely.

## Transactional reveal-and-score

**Origin**: Slice 003 (Multiple Choice), `reveal_results_atomically`.

**The pattern**: when an engine can deterministically compute an
outcome as a *consequence* of a state transition, perform that
computation inside the same atomic database operation as the
transition itself — never as a follow-up call from the domain layer.

**Why it matters**: this eliminates an entire class of partial-
completion bug (a state persisted as "transitioned" with its
consequence not yet applied) by construction, rather than by retry
logic bolted on afterward. Multiple Choice's automatic scoring at
reveal is the first instance: the same Postgres function that flips an
interaction instance to `RESULT_REVEAL` also evaluates every
submission and writes the resulting point awards, all inside one
transaction.

**When to reach for it**: any future engine with a server-computable
outcome at reveal — an auto-tallied vote, a prediction scored against
a later-revealed actual outcome, anything where "the answer" is
knowable the instant the state transitions.

## Stale-response race guard

**Origin**: Slice 004 (Passive Synchronization), independently
implemented in both `host.html`'s `hostRefresh()` and
`participant.html`'s `participantRefresh()`.

**The pattern**: before awaiting an async request, capture the
identifier of whatever the request is *about* (a session id, in this
case). When the response arrives, compare that captured identifier
against the current one — if they no longer match, discard the
response instead of applying it.

**Why it matters**: `sessionSync.js` itself is deliberately unaware of
sessions or requests — it only knows when to call back into the page,
never what the callback is about. That means it cannot protect against
a response arriving *after* something newer has superseded it (e.g.
after a new session was created while an old request was still in
flight) — only the caller, which knows what "current" means, can. This
was found the hard way: a delayed "session not found" response from a
request made before a session existed could arrive after the real
session had already started, and if treated as terminal, would
silently kill passive sync with no visible error.

**When to reach for it**: any client-side code that fires a request
whose target could change before the response arrives — which, given
passive sync runs continuously in the background, is effectively every
request in `host.html` and `participant.html`.

## Role-aware response projection

**Origin**: Slice 003, `GET_SESSION`'s `preparedQuestions` field.

**The pattern**: a single response type where a field's *presence*, not
just its *value*, depends on which authorized caller is asking — the
host sees each prepared question's correct answer before it's ever
asked; a participant sees `null` for the same field, despite both
being equally authorized to call `GET_SESSION` at all.

**Current state — a precedent, not yet an abstraction**: today this is
one inline `isHost ? ... : null` ternary at the single call site that
needs it. This entry exists so the precedent is visible, not because
the abstraction has been extracted — it hasn't, because it's only
needed once so far. **Extract it** (a proper "host view" vs.
"participant view" projection function) if and when a second or third
role-differentiated field appears; extracting it now, with only one
example, would be guessing at a shape from insufficient evidence.

## Workspace/editor engine seam

**Origin**: Slice 006 (Authoring Workspace), `ITEM_EDITORS[engineType]`.

**The pattern**: the Authoring Workspace itself — the draft queue,
Create/Import/Review, filtering, save — never references a single
Multiple-Choice-specific field. Everything that needs to know what an
item of a given engine's type actually looks like (its fields, how to
validate it, how to summarize it in one line, how to render its full
editor) goes through one seam: `ITEM_EDITORS[item.engineType]`.

**Current state — designed for reuse, not yet proven by reuse**: there
is exactly one key in that object today, because Multiple Choice is
the only engine with authored content so far. This pattern is included
here because it was *deliberately* built with a second engine in mind,
not because a second engine has actually validated it yet — a future
engine (Pictionary, Photo Challenge, Truth or Dare) provides its own
`createBlank` / `validate` / `summary` / `renderFields` and should need
to touch nothing else in the workspace to do so. If a second engine's
authoring needs turn out not to fit this shape cleanly, that's real
evidence the seam needs revising — treat it as a hypothesis worth
re-checking against the first real second engine, not as settled.

## Derive, don't persist, a read-model fact reconstructible from immutable source data

**Origin**: Multiple Choice's `correctness` (Slice 003) and Voting's `placement` (Slice 007) — reached independently, at different times, for different engines, by the same underlying reasoning, not copied from one to the other.

**The pattern**: when a read-model fact (a per-submission correctness flag, a per-candidate rank) can be deterministically recomputed, on demand, from source data that is already immutable by the time anything is allowed to read the fact, compute it at read time instead of writing and maintaining a separate stored copy. Multiple Choice never stores `isCorrect` — `getSession.ts` computes it from `selectedIndex === correctOptionIndex` on every call. Voting never stores `placement` — `computeVotingResults` recomputes standard-competition rank from `votes` on every call, shared by both `InMemorySessionRepository` and `SupabaseSessionRepository` specifically so the two implementations can never disagree with each other.

**Why it matters**: a stored copy of a derivable fact is a second source of truth that can go stale or disagree with its own source the moment something forgets to keep it in sync — the same class of bug Transactional reveal-and-score exists to prevent for facts that *do* need to be written. Deriving removes that failure class by construction, for the specific case where nothing needs to be written at all.

**Boundary — this is not "derived state should never be persisted"**: persisting a derived fact is the correct choice once any of the following is true, and none of it applies to either example above: the fact needs aggregating *across* Interaction Instances (Shared Game State's `champion`, per `ADR-012`, where re-deriving from raw per-instance data on every read stops being cheap); read performance genuinely requires a stored copy; the fact must stay stable even if the derivation logic changes later (a historical/audit requirement); or the source data isn't actually immutable by the time the fact is read. "Immutable source data + cheap deterministic recomputation" is the actual test — not "is this value derived."

**When to reach for it**: a future engine whose result at reveal is a pure function of data that the same reveal-time state transition already write-locks.

## Deliberately not included here

The core "generic Interaction Instance + engine-specific extension
table" pattern that both Open Response and Multiple Choice already
follow is **not** duplicated in this document — it's already
thoroughly covered by ADR-007, ADR-008, and ADR-009 in the
constitutional Architecture Decision Record, and by
`Session_Architecture.md`. Repeating it here would fragment the same
knowledge across two documents instead of consolidating it.
