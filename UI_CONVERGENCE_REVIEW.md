# UI Convergence Review

Performed after Slice 006 (Authoring Workspace), before any UI
Convergence implementation began. The URBANO Brandbook v2.0
(`Projects/Urbano/Brandbook v2.pdf`) was read in full and used as
constitutional design authority; the actual current CSS/markup of
`host.html` and `participant.html` was inspected directly rather than
from memory. Written into the repository after the fact, per explicit
instruction, so this review doesn't remain chat-only.

## Governance note: the proposed purple accent

The Brandbook is unusually explicit and restrictive here: *"Tres
colores. Nada más"* — charcoal, gold, ivory, with a stated 82/14/4
usage ratio and an explicit warning that even gold should barely
register ("si el dorado se siente presente, es demasiado"). Introducing
a fourth color meant to carry real visual weight during gameplay
moments is a genuine amendment to a deliberately minimal system, not a
small addition — and the Brandbook's own Governance section gives a
specific Decision Framework for exactly this kind of call.

Running it through that framework: the idea has real merit *because*
it's scoped to rare, charged moments (a correct answer, a reveal, a
winner announcement) rather than general UI theming — the same
restraint discipline gold already follows, applied to a second accent.
It would stop feeling like URBANO the moment it crept into buttons,
backgrounds, or general "gaming" chrome rather than staying confined
to celebration instants.

This was not treated as already-decided. Ratifying a permanent
Brandbook amendment is a decision for whoever holds brand authority
over it. The user subsequently confirmed this explicitly: the purple
accent (and the rest of what became the "Experience Layer" — reveal
animation, celebration, dimming, glow, future sound/haptics) is to be
treated as an **experiment**, evaluated per-hypothesis
(hypothesis / expected emotional outcome / implementation / validation
criteria / playtest observations / final decision), with successful
hypotheses graduating into a future Brandbook v3 Applications section
only after real playtest evidence — not decided during implementation.

## Findings, against the Brandbook

**Visual identity — near-total mismatch, cheap to fix.** Both pages
ran on a light lavender background (`#f5f5fb`), white cards, and an
indigo/violet accent (`#4f46e5`) for every button and badge — the
opposite of URBANO's charcoal-first, 82% dark palette. The existing
"gold" variable (`#d97706`, an amber) wasn't even the Brandbook's
actual gold (`#D4AF37`), and was used far more liberally than the
Brandbook's 4%-and-barely-visible discipline — every standings score
was gold-colored. Typography was a system-font stack, not Montserrat.
There was no "U" mark anywhere. The one genuinely good sign: color was
already expressed almost entirely through CSS custom properties in one
`:root` block per file, not scattered literal hex values — re-theming
was a contained, low-risk change, not a rewrite.

**Voice — utilitarian throughout, including on screens guests see.**
"Drives the session forward; does not participate." "Session (dev
info)." Raw `sessionId`/`hostToken` displayed as plaintext key-value
pairs. None of this is "premium, corto, en voseo," and displaying a
raw bearer credential on screen is both a leftover dev-harness artifact
and, separately, actively anti-premium.

**Gameplay presentation and celebration moments — zero investment.**
No `transition`, `animation`, or `@keyframes` anywhere in either file.
The reveal of a correct answer, the winner banner appearing, a
standings update — the highest-emotional-stakes seconds in the whole
product — all rendered as an instant, jarring DOM swap. Exactly where
Brand Principle 4 (Recognition) has the most to offer and where
nothing had been built yet.

**Mobile UX — a real defect, not polish.** Neither file had a
`<meta name="viewport">` tag. On a product played almost exclusively on
participants' phones, this meant mobile browsers rendered the page at
desktop width and scaled it down rather than laying out for the
device.

**Host vs. participant experience.** `host.html` does double duty as
both a pre-game content console (the Authoring Workspace) and a
live-play control surface, with no visual distinction between the two
modes. `participant.html` is simpler and closer to what a guest
actually experiences moment-to-moment, making it the higher-leverage
target for anything gameplay-feeling.

**What should intentionally stay utilitarian.** The Authoring Workspace
is backstage, pre-game tooling — closer to a content-management
console than a guest-facing moment; reasonable for it to stay plain
even after everything else converges. "Check for updates" is load-
bearing recovery functionality (Slice 004's explicit design) and should
stay, just presented more unobtrusively. The mechanisms behind
dev-only surfaces (sessionStorage credential persistence, the raw JSON
debug data) should stay exactly as they are — only their default
visibility to a guest needed to change.

## Prioritized roadmap

**Tier 1 — foundational, cheap, zero risk to any validated capability,
all presentation-layer only:**
1. Add `<meta name="viewport">`.
2. Remove the `[SYNC DEBUG]` panel and the raw-response debug block
   from the default view; stop displaying raw `hostToken`/
   `participantToken` values on screen, keeping the credential
   mechanism itself untouched.
3. Re-theme the shared chrome (background, cards, buttons, typography)
   to charcoal/gold/ivory and Montserrat.
4. Replace the text-pill brand badge with the actual "U" mark.

**Tier 2 — gameplay presentation and voice, moderate effort, highest
leverage on what guests actually feel:**
5. Design a deliberate reveal moment and winner moment — where
   Recognition earns its place, and where the purple-accent experiment
   would actually apply.
6. A voice/copy pass on guest-facing strings only (not the Authoring
   Workspace's internal labels).
7. A mobile-specific layout pass for `participant.html` beyond the
   Tier 1 viewport fix — touch targets, spacing, safe areas.

**Tier 3 — larger scope, sequenced deliberately rather than rushed:**
8. Formal documentation of the purple accent (and any other surviving
   Experience Layer hypothesis) as its own Brandbook section, if and
   when evidence supports it.
9. A real shared component layer between `host.html` and
   `participant.html`, replacing the current deliberate small
   duplication between them.
10. Visual separation of host "backstage" (Authoring Workspace) from
    host "onstage" (live-play controls) as two distinct modes.

## Sequencing recommendation

Not cleanly "before" or "after" Experience Composition — split the
same way the Experience-Composition-vs-third-engine tension was
resolved.

**Tier 1 belongs before Experience Composition, unconditionally.** It
is entirely orthogonal to the domain layer and purely additive. If it
waits, Experience Composition's new surface (an Experience picker, a
third engine's authoring editor) gets built in the old harness style
and then has to be converted afterward — strictly more total work than
converging the shared chrome once and building new surface directly
against it.

**Tier 2 belongs in step with, or just after, the third engine — not
before it.** Designing a celebration/reveal treatment against only
Open Response and Multiple Choice risks the same "two similar engines"
limitation flagged for Experience Composition itself — a genuinely
different third engine (no correct answer, different scoring shape)
may need a different celebration shape entirely.

**Tier 3 can trail behind both**, picked up opportunistically once the
shape of Experience Composition's own new UI needs is known.

## Outcome

Tier 1 was implemented following this review — see
`UI_CONVERGENCE_IMPLEMENTATION_RECORD.md` for exactly what changed and
how it was verified. Tier 2 has not started, and does not start until
Tier 1 is validated by a real playtest, per explicit agreement to
protect the evidence by protecting the sequence.
