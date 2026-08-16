# URBANO Gaming Application Shell

## Objective

Create the first member-facing URBANO Gaming landing/application shell — a real product surface establishing URBANO Gaming as something a member enters directly, rather than exposing the existing host/participant development surfaces (`host.html`, `participant.html`) as the primary entrance. Prioritized ahead of the paused Slice 008/009/010 structural roadmap because of a near-term commercial objective: preparing URBANO Gaming to receive a Soccer Predictions experience (the validated Finca 8 Golazo capability, currently under a separate Foreign Evidence Intake) around the August 22 Real Madrid match.

This is **not** an Interaction Engine slice and is not numbered as one. It is a member-facing product-surface implementation, using this repository's existing precedent for non-slice-numbered, descriptively-named structural work (`UI_CONVERGENCE_IMPLEMENTATION_RECORD.md`, `STRUCTURAL_TIER2_IMPLEMENTATION_RECORD.md`, `EXPERIENCE_LAYER_IMPLEMENTATION_RECORD.md`, `SESSION_CONTINUITY_IMPLEMENTATION_RECORD.md`, `AUTHORING_WORKSPACE_IMPLEMENTATION_RECORD.md`) rather than inventing a new evidence-artifact convention.

Explicitly out of scope, per instruction: any Prediction mechanics, schemas, scoring, geolocation, OTP, or settlement logic; any Golazo reconstruction from memory; any Slice 008/009/010 work; any auth system, Gaming-specific accounts, or connection to the existing Supabase project's service-role credential for anything resembling user identity.

## What was found before implementing

- **No authentication abstraction exists anywhere in this codebase.** A repository-wide search for auth-related code (`auth.`, `signIn`, `signUp`, `getUser`, any Supabase Auth usage) found nothing — the only Supabase credential in use is `SUPABASE_SERVICE_ROLE_KEY`, a server-side, RLS-bypassing key used exclusively by `SupabaseSessionRepository`, never anything resembling user login. Host/participant identity is entirely bespoke per-session tokens (`hostToken`/`participantToken`, generated at `CREATE_SESSION`/`JOIN_SESSION`, held in `sessionStorage`) — not tied to any real member identity. There was therefore nothing to reuse and nothing to avoid reusing; the auth seam below is new, not a repurposing of anything existing.
- **The application has no React UI anywhere.** `react`/`react-dom` are present only transitively (as a `next` dependency); every existing page (`host.html`, `participant.html`) is plain static HTML with inline `<style>` and vanilla JS, and `app/` contains only API route handlers (`app/api/sessions/...`), no page components. The shell below follows this same established pattern rather than introducing React for the first time in this repository.
- **The existing Product Experience Catalog** (`Product/Experience_Catalog.md`, external to this repository) names the football prediction experience "Golazo" as its internal/architecture name. No member-facing copy override was found there or anywhere else in Product guidance, so the founder-supplied "Soccer Predictions / Predict the biggest matches. Compete with the community." copy was used as given.
- **`Product/Interaction_Engine_Taxonomy.md`'s Voting section** (from the Post-Slice-007 architecture checkpoint) already names a plain participant roster as a valid Candidate source backed by Session Membership — consistent with, though not a dependency of, this shell's separate Community Voting catalog entry, which is presentational only here.

## Route structure introduced

- **`GET /`** — `app/route.ts`, a thin route handler reading and returning `public/index.html`'s markup. A `next.config.cjs` rewrite (`{ source: "/", destination: "/index.html" }`) was tried first and did not work: Next's App Router (`app/api/...`) claims an unmatched `/` as its own not-found page before an ordinary rewrite runs, and a `beforeFiles` rewrite did not change this either. The route-handler approach is the same thin-route pattern already used throughout `app/api/`, and was verified to resolve `/` to `200` with the correct landing-page content, including in a production build (where Next statically pre-renders it, per the build output: `○ / … Static`).
- **`GET /soccer-predictions.html`** — new static file, served directly from `public/` exactly like `host.html`/`participant.html` already are.
- **`GET /urbanoAuth.js`** — new shared static script, served the same way as the existing `sessionSync.js`.
- **`/host.html`, `/participant.html`, all `/api/sessions/*` routes** — untouched, unmodified, verified still `200`.

No React, no new build step, no restructuring of the existing API route tree.

## Authentication seam

`public/urbanoAuth.js` — a small, dependency-free module (`UrbanoAuth`) with `getState()` (always returns `{ status: "unauthenticated" }`), `isAuthenticated()` (always `false`), `signIn()` (resolves `{ status: "not_connected" }`, never fabricates success), `signOut()`, and `attachSignInButton()` (wires a button + adjacent status element to honest copy: *"URBANO sign-in isn't connected here yet — you can still browse Gaming. This will use your existing URBANO membership once identity is connected."*).

This is the entire seam. It intentionally does not decide between Supabase Auth, cross-app SSO, OAuth/OIDC, or shared session cookies — that decision depends on the Golazo Foreign Evidence Package and canonical-identity investigation, per instruction. When a real provider is chosen, only this one file should need to change; every page that calls `UrbanoAuth` today will pick up the new behavior without modification. The catalog remains fully browsable while unauthenticated; nothing currently requires participation, so no protected-entry gate was built yet — the seam exists so one can be added at the point of participation later without redesigning the shell.

## Landing-page hierarchy (as implemented)

```
URBANO Gaming identity (mark, wordmark, purple "Gaming" badge)
↓
"Sign in with URBANO" entry (honest, non-functional)
↓
Featured Experience — Soccer Predictions (large card, purple Experience-Layer accent)
↓
Explore Games & Experiences (horizontally-scrollable catalog, mobile-safe)
```

## Catalog contents and status assigned

Current state (after the Trivia Playtest follow-up below — see that section for the full history of how Trivia's status changed twice):

| Experience | Status | Actionable | Destination |
|---|---|---|---|
| Soccer Predictions | Featured | Yes | `/soccer-predictions.html` |
| Trivia | Playtest | Yes | `/trivia-playtest.html` |
| Community Voting | Coming Soon | No | — |
| Level 33 | Coming Soon | No | — |
| Duels | Coming Soon | No | — |

Community Voting was deliberately marked **Coming Soon**, not Experimental, per instruction to use the more conservative status when uncertain: Voting the *engine* is production-validated, but it has no finished member-facing standalone entry — no self-serve way for a member to start a Community Voting round today, and its Segment/Turn/scoring member experience remains scheduled behind the paused structural roadmap. Presenting it as "Experimental" (implying it is playable now, just rough) would overstate current reality.

Coming Soon cards render as inert `<div>` elements with no `href` and no click handler at all — verified directly (not just visually dimmed) via a DOM query confirming zero of the four Coming Soon cards carry a navigable element, versus the single actionable card (Soccer Predictions) rendering as a real `<a>` tag.

**Trivia — corrected, per explicit founder review.** An earlier version of this shell marked Trivia "Available" and routed it to `/participant.html`, reasoning that `participant.html` was "genuinely the only current member-side surface" for the validated Multiple Choice engine. That reasoning was rejected on review, correctly: `/participant.html` is a session-participation surface requiring an externally created session and room code — it is not a standalone Trivia Experience, and routing a member with no room code in hand into it would be misleading regardless of how the card's subtitle was worded. **Validated engine capability is not the same thing as a finished member-facing Experience.** Multiple Choice/Trivia is real, tested, and production-validated as an *engine* — but no self-serve, member-initiated Trivia Experience exists yet on top of it. The Gaming catalog now correctly reflects that gap by marking Trivia Coming Soon and non-actionable, exactly like Community Voting, Level 33, and Duels, rather than routing members into session infrastructure that was built for hosted playtests, not for a stranger arriving at the landing page. `/participant.html` itself is unchanged and remains directly reachable at its existing path for hosted/playtest sessions — only the landing catalog's link to it was removed.

## Trivia Playtest follow-up (founder-directed)

The reasoning in the paragraph above is preserved unchanged and remains correct: it is the reason Trivia was marked Coming Soon in the first place, and that reasoning is not being revised or walked back here.

Subsequently, the founder authorized a narrower, explicitly-scoped follow-up: an **invited playtest entrance**, not a reclassification of Trivia as a finished Experience. The distinction the founder drew is preserved exactly: *validated Interaction Engine capability is not the same thing as a finished member-facing Experience.* Trivia is not being marked "Available," "Live," "Released," or "Production Ready" — it is marked **Playtest**, a status deliberately chosen to be unmistakable as preview/testing, not general availability. The purpose is to let invited reviewers (starting with Roberto, who is separately the implementer of the historical Finca 8 Golazo capability under Foreign Evidence Intake) coherently inspect the already-validated, already-shipped hosted Trivia capability, without a member-facing landing page routing strangers directly into session infrastructure built for hosted playtests.

**What changed:** the Trivia catalog card became actionable again, but its destination is no longer `/participant.html` directly. It now opens a new, small dedicated page, `public/trivia-playtest.html`, which explains in member-facing language that this is an early playtest, and offers two explicit actions — **Host a Trivia Session** (→ `/host.html`) and **Join a Trivia Session** (→ `/participant.html`) — rather than silently picking one. `/host.html` and `/participant.html` themselves remain completely unmodified; only a new, small routing page was added in front of them. No new session logic, matchmaking, or gameplay change was made anywhere. `UrbanoAuth` was not touched — the same honest, non-functional "Sign in with URBANO" seam appears on the new page, and no mock or temporary authentication was added merely to let a reviewer in.

## Soccer Predictions destination behavior

`public/soccer-predictions.html` — a polished, member-facing pre-launch page: brand header (with the same honest sign-in seam), a hero card explaining what the experience will do ("Predict the biggest matches and compete with the community... check back soon to make your picks"), an "Opening Soon" status pill, and a short "What to expect" panel. No internal development language anywhere (no "Roberto," "FEI," "Golazo," "migration," "pending"). No prediction mechanics, match data, forms, schemas, or scoring UI — purely presentational, as instructed, intended to receive the reviewed Golazo/Finca 8 implementation once the Foreign Evidence Package is returned.

## Files changed

Original checkpoint (`6ea3e82`):
- `app/route.ts` — new; serves the landing page at `/`.
- `public/index.html` — new; the landing shell.
- `public/soccer-predictions.html` — new; the Soccer Predictions destination shell.
- `public/urbanoAuth.js` — new; the authentication seam.
- `APPLICATION_SHELL_IMPLEMENTATION_RECORD.md` — this file.

Trivia Playtest follow-up (this pass):
- `public/trivia-playtest.html` — new; the Trivia Playtest destination, routing to `/host.html` and `/participant.html`.
- `public/index.html` — modified; Trivia's catalog entry changed from Coming Soon/inert to Playtest/actionable, pointing at `/trivia-playtest.html`. The `status-available` CSS class was renamed to `status-playtest` to match (same ivory-outline visual treatment, distinct from Featured's purple and Coming Soon's muted styling — never rendered as equivalent to Featured).
- `APPLICATION_SHELL_IMPLEMENTATION_RECORD.md` — this file, updated.

No changes to `host.html`, `participant.html`, `sessionSync.js`, `urbanoAuth.js`, `lib/session/*`, any API route, any migration, or `next.config.cjs` at any point across either pass (a rewrite was tried there and reverted once the route-handler approach proved correct — final state is unchanged from before this work).

## Verification

- `npx tsc --noEmit`: clean.
- `npm test`: 219/219 passing, unaffected (presentation-only change; no domain/API code touched).
- `npm run build`: clean; `/` correctly statically pre-rendered.
- Dev-server verification: `/`, `/soccer-predictions.html`, `/urbanoAuth.js`, `/host.html`, `/participant.html` all confirmed `200`.
- Desktop (native viewport) and mobile (375×812) screenshots taken of both new pages: header, Featured card, and carousel all render correctly at both sizes; sign-in click shows the honest not-connected message with no fabricated authenticated state.
- Confirmed no page-level horizontal overflow at mobile width (`document.documentElement.scrollWidth === window.innerWidth`) — only the intended carousel scrolls horizontally, verified by scrolling it to reveal the Duels card at the far end.
- Confirmed via DOM inspection that all four Coming Soon cards (Trivia, Community Voting, Level 33, Duels) carry no `href` or click handler; only the Featured Soccer Predictions card does.

**Trivia Playtest follow-up verification** (re-run after the change above):
- `npx tsc --noEmit`, `npm test` (219/219), `npm run build`: all clean, re-run and unaffected.
- DOM inspection re-confirmed: Soccer Predictions (`<a>`, Featured) and Trivia (`<a>`, Playtest) are the only two actionable cards; Community Voting, Level 33, and Duels remain inert `<div>` elements with no `href`.
- `/trivia-playtest.html` confirmed `200`; its "Host a Trivia Session" and "Join a Trivia Session" buttons confirmed via direct click-through to land on the real, unmodified `/host.html` and `/participant.html`.
- Desktop and mobile (375×812) screenshots confirm the Playtest pill (ivory outline) is visually distinct from and clearly subordinate to the Featured card's purple glow — never rendered as equivalent.
- No page-level horizontal overflow at mobile width on either `/` or `/trivia-playtest.html` (`document.documentElement.scrollWidth === window.innerWidth`, verified on both).
- `/host.html` and `/participant.html` re-confirmed byte-for-byte unchanged and directly reachable.

Not deployed, per instruction.

## Explicitly deferred / unresolved pending the Golazo Foreign Evidence Package

- Soccer Predictions mechanics, schemas, scoring, geolocation, OTP, and settlement — entirely undesigned here, intentionally.
- Which identity mechanism (Supabase Auth, cross-app SSO, OAuth/OIDC, shared cookies, other) will back "Sign in with URBANO" — depends on the canonical-identity determination the Foreign Evidence Intake is making.
- Whether/how Prediction generalizes beyond soccer — the shell's catalog and copy do not assume "Prediction means soccer forever" (the Soccer Predictions card and destination are named for the sport specifically, not for "Prediction" generically), but no abstraction for other prediction categories was built.
- The Trivia self-serve entry gap named above.
- A protected-participation gate at the point of actually joining/playing an Experience — not needed yet, since nothing in this shell currently requires authentication to use.

## Recommended next smallest step while Golazo evidence remains pending

Nothing further on this shell is required to receive the Golazo evidence review — it is intentionally a stable, low-churn surface. The smallest next step, when authorized, is independent of this work: continue the paused Slice 008 (Segment/Turn grouping) once the Prediction deployment priority stabilizes, per the founder's own stated sequencing. No action recommended on this shell itself until the Foreign Evidence Package returns and Soccer Predictions' real mechanics are scoped.
