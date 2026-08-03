# Multi-Human Playtest Protocol — Role-Separated Harness (commit `500da92`)

**Status: this protocol has been run.** Its findings fed into a
subsequent Repository Reassessment, constitutional bootstrap, and Next
Slice Selection process, which produced Slice 001 (Session /
Interaction separation — see `HANDOFF.md` and `PROJECT_STATUS.md` for
current status). The methodology below remains valid and reusable for
a *future* playtest (e.g. of the harness as updated for Slice 001's
re-invocable multi-interaction flow) — it is kept as a reference
protocol, not as a still-pending task.

Purpose: gather behavioral evidence from real humans using the committed
`public/host.html` and `public/participant.html` interfaces, to determine
what the next evidence-justified implementation slice should be. This is
an observation exercise, not an implementation task — no code changes
should result directly from running it; findings feed a subsequent
Repository Reassessment.

## 1. Minimum devices / tabs

- 1 device or browser tab running `public/host.html` (the host role).
- At least 2 separate devices or tabs running `public/participant.html`
  (2 distinct humans, or 1 human across 2 tabs/devices if a second
  human isn't available — a single participant cannot exercise
  submission-progress communication, which depends on more than one
  eligible respondent).
- Prefer 3+ participants if available: richer signal on progress
  ("N of M submitted"), reveal-list comprehension, and room-code
  misuse (one participant deliberately mistyping).

## 2. Normal lifecycle to test

Run the full committed lifecycle once, end to end, without
interruption, observing both host and participant screens throughout:

1. Host creates a session (`public/host.html`) → room code displayed.
2. Each participant opens `public/participant.html`, enters the room
   code and a display name, joins.
3. Host locks the lobby.
4. Host starts the session (prompt becomes active).
5. Each participant reads the prompt and submits a response.
6. At least one participant revises their submission before
   submissions close (exercises "last write wins").
7. Host closes submissions.
8. Host reveals results.
9. All participants view the reveal screen, including their own
   highlighted response.
10. Host completes the session.

## 3. Deliberate failure / misuse scenarios

Attempt these only after the normal lifecycle above has been observed
once cleanly:

- A participant enters a mistyped or nonexistent room code before
  joining.
- A participant attempts to join after the host has already locked the
  lobby.
- A participant leaves the response field empty and attempts to
  submit.
- A participant submits, then revises their response a second time,
  then refreshes the browser tab before the host closes submissions —
  observe whether the "submitted" state and prior text (or lack of
  it) is communicated clearly.
- A participant tries to submit after the host has already closed
  submissions (e.g. still has the tab open on the prompt screen).
- Two participants join using the same display name.
- The host clicks "End Session" from a state other than
  `RESULT_REVEAL` (e.g. directly from `PROMPT_ACTIVE`), to observe
  whether premature completion is confusing to any participants still
  mid-flow.

## 4. Observations to record

For each run, record plainly what happened and what the human(s) said
or visibly struggled with — not just pass/fail:

- **Host comprehension**: did the host understand what each button
  did and when it was safe to click it, without prior explanation?
- **Room-code join**: did participants find and enter the room code
  without friction? What happened on a mistyped code?
- **Waiting-state clarity**: did participants understand what was
  happening while waiting (before lock, after lock, after
  submitting, after submissions closed)?
- **Prompt comprehension**: was the prompt text and expectation
  ("what am I supposed to answer, how long, is this shown to
  others") clear?
- **Submission and revision**: did participants realize they could
  revise their answer, and did the harness's "last write wins"
  behavior match their expectation?
- **Submission-progress communication**: did the "N of M submitted"
  progress indicator meaningfully inform the host's decision to
  close submissions?
- **Reveal comprehension and emotional response**: did participants
  understand the reveal screen at a glance? Any visible reaction
  (laughter, surprise, confusion) worth noting?
- **Session completion**: was it clear to participants that the
  session had ended?
- **Role-specific confusion**: anything a participant expected to be
  able to do that only the host interface offers, or vice versa.
- **Any moment a human paused, asked "what do I do now?", or acted
  differently than the interface intended.**

Capture these as raw notes per run (timestamped if convenient) rather
than pre-categorizing them — classification happens afterward, in the
Repository Reassessment.

## 5. Criteria for the next evidence-justified slice

After the playtest, only propose a new implementation slice if the
observations show a **repeated, concrete** friction point — not a
single ambiguous moment. Specifically:

- If multiple participants across runs stumble on the same step
  (e.g. everyone mistypes the room code, or nobody notices they can
  revise), that step is evidence-justified for a targeted fix.
- If confusion is isolated to one person, one run, or is resolved by
  a one-sentence clarification, treat it as noise, not evidence —
  do not implement against it.
- Do not use this playtest to justify the three-layer identity
  architecture (accounts, cross-device recovery) unless a
  participant is observed actually losing continuity mid-session in
  a way the current `sessionStorage` model cannot explain or
  recover from — that remains explicitly out of the current MVP
  boundary per prior Decision Review.
- Prefer the smallest slice that addresses the single most-repeated
  friction point observed, following the established
  Design Clarification → Plan → Implementation → Architecture Review →
  Operational Simulation → Decision Review → Verification → Commit
  workflow — not a bundle of every finding at once.
