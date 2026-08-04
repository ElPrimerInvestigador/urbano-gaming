# Slice 004 — Passive Session Synchronization: Implementation and Validation Record

**Status: implemented and validated. Not constitutionally accepted.** This record is submitted for review; it does not itself declare architectural or constitutional acceptance.

## Objective (as accepted)

Remove manual "Check for updates" clicking from the normal gameplay loop, for both host and participant, by having both pages automatically poll the existing `GET_SESSION` endpoint. The manual button remains as a recovery tool only. Per the accepted design adjustments: (1) host and participant are treated identically — no distinction between them; (2) the polling behavior is implemented once, as a small reusable client capability with `start()`/`stop()`/`pause()`/`resume()`/`refreshNow()`, consumed by both pages rather than each owning an independent timer.

## Implementation Chronology

1. **Design review** (see conversation) — reviewed the current implementation, found that every state-changing action already funnels through exactly one function per role (`hostRefresh()` / `participantRefresh()`), and that `applySessionSnapshot()` was already idempotent under redundant calls (built for manual-refresh continuity in Slice 001/002, not with polling in mind, but exactly the property polling needs). Evaluated WebSockets/Supabase Realtime, long polling, and SSE against this platform's actual constraints (stateless serverless functions, server-side-only Supabase access) and ruled all three out as disproportionate to the objective. Recommended automatic short-interval client-side polling reusing the existing refresh functions, with no backend change.
2. **`public/sessionSync.js`** (new) — `createSessionSync(onTick, intervalMs)`, returning `{ start, stop, pause, resume, refreshNow }`. Deliberately session-agnostic: this file has no knowledge of `GET_SESSION`, error types, or session state — it only decides *when* to call the function it's given, never *how*. Tab-visibility-aware: pauses on `document.hidden`, resumes (with an immediate tick) when visible again, via a `visibilitychange` listener.
3. **`host.html` / `participant.html`** — both now load `sessionSync.js` and instantiate it against their own existing refresh function (`hostRefresh` / `participantRefresh`), at a 2-second interval. `start()` is called from the same two places each page already initializes state (`createSession()`/`joinSession()` success, and the page-load `restoreState()` branch). The "Check for updates" button now calls `sessionSync.refreshNow()` instead of the refresh function directly, and gained a `title` tooltip naming its new role. Each refresh function gained two small additions: stop the loop once `state === "SESSION_COMPLETE"` (nothing further can change), and stop it on a terminal error (`SessionNotFoundError` / `SessionAccessDeniedError` — a session or access grant that polling again will never fix). A new `isTerminalSyncError()` helper, identical on both pages, makes that determination; `sessionSync.js` itself has no opinion on it.

No migration, no domain-layer change, no new API route — this is the first candidate slice that touches only the static client files.

## Discovered Deviations

None in the application code. One environment limitation surfaced during the Operational Simulation, worth recording since it shaped how validation evidence below was gathered: the browser automation tool used for this simulation does not update `document.visibilityState` the way a real browser does when switching between tabs in a multi-tab session — a backgrounded tab reports `hidden: true` persistently regardless of `tabs_select`. This is a property of the testing tool, not of `sessionSync.js` or either page; it meant tab-visibility behavior had to be validated by directly invoking the same public methods (`resume()`, and confirming `pause()`'s effect via absence of new network requests) that a real `visibilitychange` event would call, rather than through an actual tab-switch gesture. The underlying mechanism this exercises is identical either way.

## Validation Evidence

| Evidence | Result |
|---|---|
| Full in-memory suite (`npm test`, 11 files) | 177/177 passing — unchanged, as expected for a client-only change |
| `tsc --noEmit` | Clean |
| `npm run build` | Clean |
| Live-Postgres contract suite | Not re-run — no backend surface changed; last known-good state from Slice 003's review package stands |

### Operational Simulation (live browser, host + 2 participant tabs, real Multiple Choice game)

Executed with **zero manual refresh calls on the observing side** for every check below — the host tab was never told to refresh while checking participant-visible effects, and vice versa; the only calls made were the same actions a real host/participant would take (create, join, lock, author and start a question, answer, close, reveal, complete), plus the environment-limitation workaround described above for the tab-visibility checks specifically.

- **Host starts a question → participants transition automatically.** Confirmed: both participant tabs showed the new Multiple Choice prompt and options with no `participantRefresh()` call on either tab.
- **Host sees live submission progress automatically** (the approved scope addition beyond the original participant-only criteria). Confirmed: "0 of 2" → "2 of 2 submitted" appeared on the host tab with no `hostRefresh()` call.
- **Host closes submissions and reveals → participants automatically see correctness and standings.** Confirmed on both tabs: correct/incorrect banners, resolved option labels, and updated standings all appeared without any refresh call.
- **Host completes the session → the winner appears automatically for host and both participants.** Confirmed on all three, via the tab-visibility workaround for the participant tabs (see below) — "Winner: Alex (10 pts)" appeared with no button click.
- **The automatic loop stops once the session reaches `SESSION_COMPLETE`.** Verified directly by counting network requests before and after an additional `resume()` call post-completion: no new request fired, confirming `stop()` had already been triggered by the `SESSION_COMPLETE` check inside the refresh function.
- **The automatic loop stops on a terminal error, and the manual button still works as a recovery tool regardless.** Deliberately corrupted a participant's token mid-session, forced a poll tick, confirmed a `403` came back and the loop stopped (a further `resume()` produced no new request) — then confirmed `sessionSync.refreshNow()` still fired a fresh request despite the stopped loop, exactly as designed: the manual path never checks the automatic loop's state.
- **Award-in-flight (Open Response host-manual scoring) does not glitch under concurrent polling.** Fired `awardPoints()` and two overlapping `sessionSync.resume()` calls simultaneously, mimicking a poll tick landing mid-award; final state showed exactly one award (10 points, not duplicated) and the "Award" control correctly returned to its normal enabled state rather than sticking on "Awarding…".
- **Tab-visibility pause/resume**, validated via the public API directly (see Discovered Deviations): `pause()`'s effect (no ticks while backgrounded) and `resume()`'s effect (immediate tick on becoming visible) both behaved correctly when invoked directly; the `visibilitychange` listener itself was not exercised through an actual OS-level tab switch due to the tooling limitation above.

**Defects found:** none.

## Unresolved Questions (for review, not resolved here)

1. **The 2-second interval is a starting point, not a measured optimum.** No evidence yet says it should be faster, slower, or adaptive — deliberately left as a single constant per the instruction to avoid premature optimization.
2. **`sessionSync.js` is a new, third static file** (alongside `host.html`/`participant.html`), the first time this project has shared client code across the two pages via a separate `<script src>` rather than duplicating logic inline. Whether this is the right pattern to keep extending as more shared client behavior appears, versus introducing an actual build step at some point, isn't decided here — it's the smallest thing that satisfies "one capability, not two loops" for this slice specifically.
3. **The tab-visibility validation gap noted above** is a testing-tool limitation, not an application one, but it means this specific behavior wasn't proven through the literal user gesture it's meant to handle (backgrounding a real phone). Worth a quick manual check on an actual phone before relying on it for tomorrow's play, if that's a concern.

## Correction: the Real-Device Evidence Behind Addenda 1 and 2 Was Invalid

**This section supersedes the framing of Addenda 1 and 2 below.** The real-device tests referenced in both were run against `https://level33-mvp-playtest.vercel.app` — the production deployment made during the earlier deployment-crisis conversation, before any Slice 004 code existed, and never updated since. Confirmed directly: `curl`-ing that URL's `host.html` at the time showed zero occurrences of `sessionSync`, `syncDebugPanel`, or `btn-new-session`, and the Vercel deployment history showed no deployment since that one. **`sessionSync.js` was never present on the tested server, in any version, buggy or fixed, for any of these tests.**

This means the phrase "did not pass on the real device" appearing below is not accurate as originally written: there was no automatic synchronization *of any kind* running on that server for a real device to fail to exhibit. The pages under test there were the Slice 003 production build, which has always been manual-refresh-only and has never had a "Create New Session" control — both observations are therefore accurate descriptions of *that build*, not evidence about Slice 004's actual behavior on a real device, which remains untested as of this writing.

**What is not invalidated:** every defect described below was found through direct code review and confirmed through isolated reproduction independent of the device tests (intercepting timers, forcing races deliberately, counting network requests) — that evidence stands on its own and doesn't depend on which server anyone's phone happened to be pointed at. What's corrected is the *framing* that a real device had confirmed these problems or their fixes — it had not, because it could not have.

## Addendum 1: A Second Client-Lifecycle Defect, Found Independent of Device Testing

A second defect was found in the same conversation as the passive-sync work: the host could not start a new session without closing and reopening the tab. Its underlying cause is real and predates Slice 004 (see below); it was accurately observable on any build, including the one actually under test at the time.

### Defect 5 — `resume()` trusted a timer handle a real browser can silently invalidate while backgrounded

**Root cause.** The original `resume()` trusted its own `timer` variable as proof the underlying interval was still alive: `if (timer === null) { timer = setInterval(...) }`. On a real phone, backgrounding or locking the screen can cause the browser to silently invalidate the running interval — no callback, no error, it simply stops firing — while `timer` still holds that now-dead handle. `resume()` saw a non-null handle, assumed it was fine, and never replaced it. The function returned normally; nothing was actually ticking anymore. Listening only to `visibilitychange` compounded this — it does not reliably fire for every path a mobile browser uses to bring a page back, in particular restoration from the back-forward cache.

**Fix.** `recreateTimer()` now unconditionally clears whatever handle exists and creates a fresh one, on every "the page might be active again" signal — it never treats a handle's mere presence as evidence it still works. Added `pageshow` and `focus` as equivalent "became active" signals alongside `visibilitychange`, all funneling into the same `resume()` path. Added temporary `console.log("[sessionSync] ...")` diagnostic lines at every lifecycle transition, per the standing invitation to use them for this investigation — safe to remove once mobile behavior is confirmed stable across a normal playtest, left in for now.

**Revalidation.** The browser-automation environment used for the original Operational Simulation cannot reproduce a real phone's silent-interval-invalidation behavior, so this was validated by directly reproducing the actual failure mechanism rather than re-running the same surface-level check that had already (wrongly) passed once:

- Intercepted `setInterval`/`clearInterval` globally and drove `start()` → `resume()` ×4 → `pause()` → `resume()` → `stop()` on an isolated instance: net live intervals stayed at exactly 0 or 1 throughout (6 `setInterval` calls, 6 `clearInterval` calls) — confirms the fix does not leak duplicate timers, which an unconditional "always recreate" approach could plausibly have introduced as a new bug.
- **Direct reproduction of the reported bug**: created an isolated instance, let it tick naturally once, then killed its real underlying interval directly from outside — bypassing `pause()`/`stop()` entirely, exactly mimicking a browser silently invalidating it during backgrounding — then called `resume()`. Ticking resumed and continued (tick count advanced from 1 to 3 after the simulated kill). This is the same failure mode reported from the phone, deliberately reconstructed and confirmed fixed, not merely re-tested under the same conditions that already looked fine once.

### Defect 6 — Host could not start a new session without reloading the page

**Root cause.** The only control that ever called `createSession()` was the `#pre-create` button, and `showSessionPanels()` hides that div permanently the first time any session begins — there was never a path back to it short of reloading `host.html`. This predates Slice 004 (true since Slice 001), but Slice 004's explicit "multiple consecutive sessions in one tab" requirement is what made it a blocking defect rather than an unnoticed gap. `createSession()` itself already resets every client-side cache this app carries (added during Slice 003's own second-session-stale-state fix) and re-arms `sessionSync` via `start()` — the only missing piece was a visible trigger once a session was underway.

**Fix.** Added a "Create New Session" button, wired directly to the existing `createSession()` (no new function — it already did everything needed), shown only when `sessionLifecycleState === "SESSION_COMPLETE"` so it can't be clicked mid-game by mistake.

**Revalidation.** Live, via an actual DOM `.click()` dispatch on the new button (not a direct function call): completed a session with a deliberately-left-over draft question still in the authoring form, clicked "Create New Session," confirmed a genuinely new `sessionId`/room code with zero leftover state (no stale draft, no stale participants, no queue, no standings), then ran a **complete second game** through it end-to-end in the same tab — a real participant joined the new room code, a full lock → start → close → reveal → complete cycle ran, and "Create New Session" correctly reappeared at the end. Confirms this isn't just a clean empty shell after clicking — the second session is fully playable.

### Re-run regression evidence

177/177 in-memory tests, clean `tsc --noEmit`, clean `npm run build` — all unchanged, as expected, since both fixes remain entirely within `sessionSync.js` and `host.html`.

## Addendum 2: A Second Real Race, Also Found Independent of (Invalid) Device Testing

A retest was reported as failing after Addendum 1's fix — but per the Correction above, that retest was also against the never-updated production build, so it carries no evidence about Addendum 1's fix specifically. Independent of that report, re-reading `sessionSync.js`'s own code surfaced a second, genuine race that Addendum 1 had not anticipated, described below on its own merits.

**Root cause.** Addendum 1's fix added a `pageshow` listener to catch back-forward-cache restoration. `pageshow` fires on *every* page load, not only bfcache restoration — including the very first load, before the host has created a session or the participant has joined one. With `stopped` defaulting to `false`, that first `pageshow` called `resume()` immediately — ticking *before `start()` had ever been called* — firing a `GET_SESSION` request against a session that didn't exist yet. That request's response can resolve *after* the real, legitimate `start()` moments later (from `createSession()`/`joinSession()`). Since a "session not found" response is treated as terminal, that stale, irrelevant response called `sessionSync.stop()` — silently killing the loop that had only just legitimately started. Had this shipped, the symptom would have looked exactly like "the automatic loop never does anything, manual refresh and direct calls still work" — which is worth naming even though it's not what the invalid device report actually demonstrated, since it's a real, reachable bug in the code as it stood after Addendum 1.

This means **Addendum 1's fix was independently correct and remains necessary — the dead-timer-handle problem it fixed is a genuine, separate hazard for a real backgrounding cycle — but it was incomplete on its own**, and this second race would have surfaced the first time this code actually ran anywhere. Both are now fixed, in code never yet deployed to any environment.

**Fix, two parts:**

1. **`sessionSync.js` gained a `started` flag, distinct from `stopped`.** Lifecycle events (`resume()`, and therefore `pageshow`/`focus`/`visibilitychange`) are now no-ops until the caller has explicitly called `start()` at least once. A page that has never started anything has nothing for a lifecycle event to resume — this is the one thing the module can know for certain about its own state without needing to know anything about sessions. Also added a `ticking` guard preventing a tick from starting while a previous one's `onTick()` promise is still unresolved, closing the more general version of the same hazard (an old, slow-resolving request racing against a newer one).
2. **`hostRefresh()` and `participantRefresh()` (in `host.html`/`participant.html`, not `sessionSync.js`, since only the caller knows what "current" means) now capture which session a request was *for* before awaiting it, and discard the response outright if that no longer matches the current session by the time it resolves.** This closes the general case Addendum 1's fix didn't cover: any stale response — from a pre-start probe, from a session that has since been superseded by a new one, or simply from a slow mobile network — can no longer corrupt state or stop sync for a session it doesn't actually describe.

**Visible, on-screen diagnostics were added to both pages** (not console-only, per the explicit instruction that mobile console access is limited): a small panel showing sync status (not started / running / paused / ticking now / stopped), tick count, last tick time, last result, and the active session id, plus a hand-bumped build marker (`SYNC_DEBUG_BUILD`) so a stale cached copy of the file would be visually obvious rather than silently indistinguishable from the current one. Intentionally left always-visible rather than behind a flag for now, given the immediate debugging need — noted here as temporary and safe to remove once mobile behavior is confirmed stable.

**Revalidation.**

- **Reproduced the exact race directly**: confirmed a genuinely fresh page load (cleared `sessionStorage`, hard-reloaded) produces `ticks: 0`, `status: not started`, and — critically — **zero network requests** before a session is created, where the pre-fix version would have fired one. `pageshow` demonstrably fires on this load (it fires on every load); the fix demonstrably prevented it from doing anything.
- **Confirmed the full original bug scenario now works end to end from a cold start**: created a session, joined a genuinely fresh participant page (no prior state), and — without calling either refresh function manually — the host's tick count climbed and, once a tick landed while the tab was actually being treated as foregrounded, correctly showed the new participant.
- **Directly tested the stale-response guard in isolation**: started a `hostRefresh()` for the real session, then swapped `hostState` to a different session before that request resolved. Confirmed the swapped-in state was untouched by the stale response when it arrived, and `sessionSync`'s status was unaffected — the guard discarded it rather than applying it or acting on it.
- **Full regression unchanged**: 177/177 in-memory tests, clean `tsc`, clean build.

One note distinct from the application code, from the Claude Browser automation tool used for this round of *my own* verification (separate from, and not a substitute for, an actual device — noted here for completeness, not as device evidence): it exhibits real Chrome background-tab timer throttling when attention shifts to a different tab within the same multi-tab session (ticks slow to roughly once a minute) without always producing a catchable `visibilitychange` event this tool can react to. Calling `resume()` directly at any point during that throttled state immediately restored full, accurate state in every case tried. That's reassuring evidence from automated reproduction, not proof against a real phone — which, as of this writing, has still never run any version of this code and remains the actual open question.

## Addendum 3: First Valid Deployment and Production Smoke Test

Commit `23a1db1` (`feat: add passive session synchronization (Slice 004)`) pushed to `origin/main` as a clean fast-forward from `c839132`, then deployed to production via `vercel --prod`, aliased to the existing playtest URL: **`https://level33-mvp-playtest.vercel.app`**. This is the first time any version of `sessionSync.js` has existed on that server, or on any server — every prior "real-device" report in Addenda 1 and 2 predates this by definition (see the Correction above).

**Pre-smoke-test verification**, direct against the live URL, not assumed:

```
curl -s -o /dev/null -w "%{http_code}\n" https://level33-mvp-playtest.vercel.app/sessionSync.js
→ 200

curl -s https://level33-mvp-playtest.vercel.app/sessionSync.js | grep -o "Correction [0-9]"
→ Correction 1
→ Correction 2

curl -s https://level33-mvp-playtest.vercel.app/host.html | grep -o "sessionSync\.js\|syncDebugPanel\|btn-new-session\|race-fix-1" | sort -u
→ btn-new-session
→ race-fix-1
→ sessionSync.js
→ syncDebugPanel
```

Build marker confirmed live: **`race-fix-1`**.

**Production smoke test** (live browser, host + participant, both freshly loaded against the production domain with `sessionStorage` cleared first):

| Step | Result |
|---|---|
| Fresh load, before any session | `ticks: 0`, `status: not started` — confirms no premature tick on this domain either |
| Host creates a session | Room code issued, sync loop starts |
| Participant joins | — |
| **Host detects the participant automatically** | Confirmed with zero manual refresh — `PARTICIPANTS (1) Alex` appeared after ticks climbed on their own |
| Host starts a question | — |
| **Participant advances automatically** | Confirmed with zero manual refresh — prompt and submission form appeared on their own |
| Participant submits | — |
| **Host sees submission progress automatically** | Confirmed — "0 of 1" → "1 of 1 submitted" with zero manual refresh |
| Host closes and reveals | — |
| **Participant sees the reveal automatically** | Confirmed — results and standings appeared with zero manual refresh |
| Host completes the session | "Create New Session" appeared |
| **Host creates a second session from the same tab** | Confirmed via a real DOM `.click()` — new room code, new session id, zero leftover participants/queue/standings, sync loop still running for the new session |

**Difference between local and production behavior:** none observed. The same Claude Browser automation tool limitation noted in Addenda 1 and 2 (background-tab timer throttling without a reliably catchable `visibilitychange` event in this specific multi-tab harness) applies identically here — calling `resume()` directly immediately and correctly restored ticking every time it was needed during this test, exactly as in every prior automated verification. This is a property of the testing tool, observed on this domain exactly as it was on `localhost`; it is not a production-specific issue and not new information.

**What remains genuinely unverified:** an actual mobile device backgrounding/foregrounding cycle against this live deployment. Every check above ran through deliberate action or the automation tool's `resume()` API, not a real phone lock/unlock. That is the test this deployment now makes possible for the first time — described in the retest procedure below.

No claim of architectural or constitutional acceptance is made by this document.
