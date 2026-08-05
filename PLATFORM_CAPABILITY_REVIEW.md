# Platform Capability Review — URBANO Gaming After Slices 001–006

Performed as a planning and architectural transition after Slice 006
(Authoring Workspace) and a real production playtest validated
Slices 001–005 end to end. The objective was to evaluate the platform
in terms of operational *capabilities*, not individual features, and
to identify the next major capability rather than "the next feature."
Written into the repository after the fact, per explicit instruction,
so this review doesn't remain chat-only.

## Part 1 — Major operational capabilities after Slices 001–006

### 1. Sequential Interaction Lifecycle (Slice 001)

**Problem solved**: before this, a Session could run exactly one
round, ever — no multi-question trivia night, no back-to-back
activities.

**Evidence**: 121+ automated tests at the time; live multi-round
trivia sessions with correct re-invocation of `START_SESSION` after
each `RESULT_REVEAL`; refresh-continuity confirmed mid-interaction
across multiple rounds.

**What future engines inherit**: "run this, then run another, then
another, inside one continuous Session," for free. An engine author
never needs to think about sequencing — only about what one
interaction of their engine looks like.

**Risks remaining**: `currentPromptId` and interaction ordering are
explicitly an "MVP optimization, not a commitment to the long-term
gameplay model." More importantly — a Session has no concept of *what
kind of thing* it's running; it just executes whatever interactions
get started against it, in whatever order a host clicks. Small today
with one real engine; the seed of the Experience Composition gap
below.

### 2. Multi-Engine Architecture (Slice 003)

**Problem solved**: proved a second, different game format (Multiple
Choice) can be added without touching the Session/Interaction state
machine — engines are extensions, not forks.

**Evidence**: Slice 003's own Architectural Reflection is unusually
honest about this — it explicitly says the two engines validated "the
pattern doesn't immediately break," not that "the pattern is general,"
since Open Response and Multiple Choice are both single-value-per-
submission engines with symmetric information. That caveat is still
true and matters directly for what's recommended below.

**What future engines inherit**: the `engine_type` + extension-table
pattern, and the most exportable discovery of that slice — the
*transactional reveal-and-score* pattern: when an engine can
deterministically compute an outcome as a consequence of a state
transition, do it inside the same atomic operation as the transition,
never as a follow-up call.

**Risks remaining**: the `START_SESSION` parameter-accretion question
— one command gaining one more optional parameter per engine — was
explicitly flagged as needing a deliberate decision "before a third
engine, not by default momentum." There is no third engine yet, so
that decision has never actually had to be made.

### 3. Cross-Engine Scoring (Slice 002)

**Problem solved**: without a shared, engine-agnostic point ledger,
there could be no single leaderboard spanning different game formats
in one session.

**Evidence**: live 5-question mixed-outcome games with ties, joint-
winner banners, both automatic (Multiple Choice) and manual (Open
Response) scoring paths writing to the same ledger correctly.

**What future engines inherit**: any future engine can award points —
automatically or via host discretion — and land on the *same*
standings as everything else that ran in that session. This is what
makes a mixed-format party game possible at all, and it already works.

**Risks remaining**: `points_for_correct` is explicitly, twice, on
record as "a temporary Experience-Template stand-in" — there is no
actual scoring *rule* concept, only a raw number attached per award.
Nothing has tested a genuinely different scoring shape (team scoring,
participation credit with no right/wrong answer, time-based bonuses).

### 4. Passive Synchronization (Slice 004)

**Problem solved**: the single largest source of measured real-user
friction — manual "Check for updates" clicking — eliminated via a
reusable, session-agnostic polling capability shared identically by
host and participant.

**Evidence**: the most rigorously evidenced capability on this list —
multiple real-device failure/diagnose/fix cycles, ultimately confirmed
live in actual production play.

**What future engines inherit**: automatic state propagation for free.
Any future engine's state reaches every screen without that engine
ever thinking about synchronization.

**Risks remaining**: it's polling, not push, bounded by a fixed
interval — an accepted, evidence-gated tradeoff, not a defect. More
relevant going forward: an engine's *entire* state must fit through
one `GET_SESSION` response. Nothing has stress-tested that against a
heavier payload (e.g. binary content like a photo or drawing).

### 5. Session Lineage / Continuity (Slice 005)

**Problem solved**: every session used to be a dead end — rerunning a
game for the same group meant manually re-sharing a room code and
re-onboarding everyone.

**Evidence**: real production playtest, explicit confirmation of
rematches, "Join Next Session," "Join Another Session," and multiple
consecutive games all working with real people.

**What future engines inherit**: nothing engine-specific has to
change — lineage is a Session-level concept, orthogonal to which
engine(s) ran inside either session.

**Risks remaining**: this is where the platform's central identity
constraint becomes visible. Nothing about a specific human persists
*across* sessions, by explicit design, reaffirmed at every slice since
001. Correct discipline so far — but it means every future capability
wanting to remember anything about a person across more than one
session (a running score across a tournament, a name that reliably
follows them, a library they own) currently has no foundation to
stand on.

### 6. Content Authoring Workflow (Slice 006)

**Problem solved**: content preparation had become as large a
bottleneck as the software itself — a real host's own documentation
recommended a DevTools console workaround for anything past a handful
of questions.

**Evidence**: direct host-authored evidence (`PLAYTEST_READINESS.md`)
plus a full production round-trip and a deliberate first-time-host UX
walkthrough.

**What future engines inherit**: the *workspace pattern*
(Create/Import/Review, compact-list-at-scale, an editor owned by the
engine rather than the workspace) — but not authoring for their own
content shape. A future engine gets a clean seam to plug an editor
into, not free UI for its own fields.

**Risks remaining**: deliberately scoped to one session's pre-play
preparation. There is still no concept of content that outlives or
precedes a specific session.

## Part 2 — Candidate directions for the next phase

Evaluated against: what currently prevents a host from running a
complete commercial experience; what capability would unlock the
largest number of future games; what capability would future engines
otherwise have to duplicate; what capability would generate the
highest long-term leverage.

### Candidate 1 — Experience Composition (validated through a
structurally different third engine)

- **Why it belongs now**: explicitly flagged as missing in two
  separate prior slice records (002 and 003) — `points_for_correct`
  and the sequencing model are both on record as temporary stand-ins
  for a concept that "does not yet exist as software."
- **Why it should not come later**: the cost of unifying scattered,
  engine-specific scoring/sequencing assumptions only grows with each
  engine added without a shared model. This is the cheapest moment
  there will ever be — two engines, one scoring model.
- **Dependencies**: none blocking; builds on the current Session/
  Interaction/Engine/Scoring architecture as-is.
- **Risks**: real risk of premature abstraction if built against only
  Open Response and Multiple Choice again — Slice 003's own reflection
  says this generalization question "belongs to whichever engine comes
  third." Also forces the `START_SESSION` parameter-accretion decision
  that's been explicitly deferred.
- **Expected leverage**: highest of any candidate — turns "a session
  engine capable of running games" into "a platform with named,
  sellable, repeatable products."
- **Estimated scope**: medium-large — a genuinely different third
  engine (no objectively-correct-answer concept, to actually stress
  the scoring model) plus a minimal Experience-level naming/sequencing
  decision plus resolving the `START_SESSION` question deliberately.
- **Domain**: Gameplay / Architecture, with Content touchpoints.

Recommended as **one** combined effort, not two sequential slices —
building a generalized Experience concept without a genuinely
different engine to validate it repeats the "two similar engines"
limitation at a higher layer; building a third engine without using it
to inform the Experience concept wastes the one moment this
generalization question is cheap to answer.

### Candidate 2 — Content Library (reusable content across sessions)

- **Why it belongs now**: named directly by the user as "part of the
  product roadmap." Extends Slice 006, which was deliberately scoped
  to per-session-only.
- **Why it should not come later**: every future engine's own
  authoring story will re-derive "how do I let people reuse content
  across sessions" independently without this.
- **Dependencies**: benefits from, but doesn't strictly require,
  Experience Composition existing first.
- **Risks**: this is the one candidate that most directly reopens the
  identity question. Content that outlives a session needs an owner —
  today's `hostToken` is scoped to exactly one session's lifetime, with
  nothing persistent behind it. A minimal "library owner" concept,
  short of full accounts, would likely be forced here even without
  touching participant identity at all.
- **Expected leverage**: high, but the evidence behind it is
  roadmap-intent, not an incident — weaker than Experience
  Composition's paper trail of two prior slice records naming it
  directly.
- **Estimated scope**: medium — a new entity decoupled from
  `sessions`, a minimal ownership/access model, a workspace extension
  ("save as reusable" / "import from library").
- **Domain**: Content, with an Architecture dependency on the identity
  question above.

### Candidate 3 — Operational / Observability capability

- **Why it belongs now**: the most literal answer to "what currently
  prevents a host from running a complete commercial experience" —
  there is no monitoring, no incident visibility, no rate-limiting;
  verification of production health has so far relied on manually
  curling the API or driving a browser.
- **Why it should not come later**: incidents in a live commercial
  event are the worst possible time to discover there's no visibility.
- **Dependencies**: none blocking.
- **Risks**: low technical risk, but unbounded scope if not tightly
  framed — the gap between "structured logging and a lightweight
  active-sessions view" and "a full ops platform" is enormous.
- **Expected leverage**: high *if* commercial, concurrent, operator-run
  usage exists — no evidence yet that it does. Anticipatory, not
  evidenced, the same way "security posture of token handling" was in
  an earlier review.
- **Estimated scope**: small for a minimal version, large for anything
  more.
- **Domain**: Operations.

### Candidate 4 — Runtime presentation / branding layer

- **Why it belongs now**: real and evidenced (the harness pages were
  literal dev tools).
- **Why it should not come later**: every session run under
  placeholder visuals is a missed impression.
- **Dependencies**: none.
- **Risks**: low technical risk, but doesn't compound the way
  architectural capabilities do — improves every session's felt
  quality without unlocking new kinds of sessions.
- **Expected leverage**: real but bounded; nothing depends on this
  architecturally.
- **Estimated scope**: variable, incrementally addressable.
- **Domain**: Presentation / Customer Experience.
- **Status**: this candidate is what became the UI Convergence
  effort — see `UI_CONVERGENCE_REVIEW.md`. The user chose to run it
  *before* Experience Composition specifically for the Tier 1
  (Constitutional Layer) portion, since it's orthogonal to the domain
  layer and prevents Experience Composition's new UI surface from
  being built in the old harness style at all. Tier 2 (the Experience
  Layer) is sequenced in step with or after the third engine, not
  before it.

### Candidate 5 — Persistent / portable participant identity (named,
not recommended)

- **Why it's tempting**: "a complete commercial experience" starts to
  imply returning customers, which implies *some* notion of a person
  across sessions.
- **Why it should not come now**: no operational evidence for it — no
  host has asked to be remembered, no participant has asked for
  cross-session continuity. Standing guidance since Slice 001 has been
  "do not build this without product evidence," and nothing in six
  slices of real playtesting has produced that evidence yet.
- **Risk of building it anyway**: exactly the kind of premature
  investment this project's own discipline has correctly avoided six
  times in a row — architecture in search of a problem.
- **Domain**: Architecture / Customer Experience, watch-only for now.

## Recommended roadmap

1. **Next major capability: Experience Composition**, built and
   validated through one deliberately different third Interaction
   Engine. Highest-leverage move available.
2. **Following phase: Content Library.** Natural extension of Slice
   006, already on the roadmap; let the minimal content-owner
   dependency emerge from real design work rather than speculating
   about it now.
3. **Parallel, non-blocking track: runtime presentation/branding**
   (UI Convergence). Doesn't gate anything else.
4. **Evidence-gated, not scheduled: Operational/Observability and
   persistent identity.** Both real, both worth watching for
   triggering evidence rather than building preemptively.

## Status of this recommendation

This is a recommendation, not an authorization. Following this review,
the user elected to perform UI Convergence (Candidate 4, Tier 1 only)
before beginning Experience Composition — see `UI_CONVERGENCE_REVIEW.md`
for that decision and its own reasoning. No implementation work toward
Experience Composition has begun.
