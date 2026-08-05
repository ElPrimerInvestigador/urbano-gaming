# UI Convergence — Tier 1 (Constitutional Layer)

## Objective

Transform `host.html` and `participant.html` from an engineering harness toward the actual URBANO Gaming experience, using the URBANO Brandbook v2.0 (`Projects/Urbano/Brandbook v2.pdf`) as constitutional design authority. Scoped to Tier 1 only, per the accepted UI Convergence Review roadmap — direct, non-provisional application of already-ratified Brandbook rules (palette, typography, mark, mobile viewport, debug-surface removal). No domain, migration, or API changes; presentation layer only.

Explicitly out of scope for this phase: anything belonging to the Experience Layer (the purple accent, reveal/celebration animation, dimming, glow, future sound/haptics). Those are hypotheses, not constitutional decisions, and are deliberately held until this baseline is validated by a real playtest — protecting the evidence by protecting the sequence, per the agreed operational principle. Tier 2 does not begin until that playtest happens and the baseline is confirmed.

## What changed

**Color system** (`:root` in both files): replaced the placeholder indigo/lavender palette with the Brandbook's charcoal (`#0A0A0A`), gold (`#D4AF37`), and ivory (`#F5F1E8`). Every hardcoded literal color outside `:root` was individually reviewed and updated (not a blind find-replace) — see the deliberate exceptions below. `--done`/`--wrong`/`--danger` (correct/incorrect/destructive feedback) are kept as separate functional status colors, explicitly outside the Brandbook's "three colors, nothing more" identity system, the same way any strict brand system still needs an accessible semantic palette for state — documented in-line as a deliberate exception, not an oversight.

**Primary buttons are ivory-filled, not gold-filled.** This was a deliberate design decision, not a mechanical variable swap: gold stays a rare accent (room code, standings, winner banner — the actual Recognition moments), not the fill color of every action button on every screen. Making every button gold would have violated the Brandbook's own restraint discipline ("si el dorado se siente presente, es demasiado") far more than the previous indigo ever did.

**Typography**: Montserrat, loaded via Google Fonts, applied as the primary `body` font-family with the previous system-font stack retained as fallback.

**Brand mark**: the actual "U" mark (`urbano-mark.svg`, copied from `Projects/Urbano/` into `public/`) replaces the text-pill badge in both files' headers, paired with an ivory "URBANO" wordmark and a small gold-outlined "GAMING" tag — respecting "la letra nunca es dorada" (the wordmark itself is never gold; the tag is a separate, small accent, not the logo).

**Mobile viewport**: added `<meta name="viewport" content="width=device-width, initial-scale=1">` to both files — previously absent entirely, meaning mobile browsers were rendering both pages at desktop width and scaling down rather than laying out for the device. This is a real fix, not polish, given the product is played almost exclusively on participants' phones.

**Debug surfaces gated, not deleted.** The `[SYNC DEBUG]` panel, the "Debug: last raw response" block, and (host-only) the "Session (dev info)" card showing raw `sessionId`/`hostToken` are hidden by default and revealed only with `?debug=1` in the URL. The diagnostic capability itself — genuinely useful during Slice 004's real-device debugging — is fully intact; only its default visibility to a guest changed. Displaying a raw bearer credential on screen to anyone by default was also, separately, an anti-premium anti-pattern worth removing regardless of the debug question.

**A cross-cutting fix found during verification, not anticipated in the design**: native `<input>`/`<textarea>` elements don't inherit `body` text/background colors — without an explicit rule they continued rendering as stark white rectangles against the new dark theme even after every other element converged correctly. Added one rule per file (`input, textarea, select { background: var(--surface-2); color: var(--ink); }` plus a placeholder color rule) to fix this globally rather than patching each of the half-dozen more specific input selectors individually.

## Files changed

- `public/host.html`, `public/participant.html` — all changes above.
- `public/urbano-mark.svg` — new static asset (the U mark, verbatim from the Brandbook source).

No changes to `lib/session/*`, migrations, API routes, or any tested domain behavior.

## Validation

- `npx tsc --noEmit`: clean.
- `npx vitest run` / `npm test`: 181/181 passing, unaffected as expected for a presentation-only change.
- `npm run build`: clean.
- Live verification against the running dev server: full round-trip through a real game (create session → join as a participant → lock lobby → start an Open Response interaction → submit → close → reveal → award points → complete session), confirming via computed styles and screenshots that the palette, mark, mobile viewport, ivory-filled primary buttons, and gold-accented recognition moments (standings score, winner banner) all render correctly on both the host and participant surfaces, including at a mobile viewport width (400px).
- Confirmed via direct inspection that `?debug=1` correctly reveals the diagnostic surfaces and their absence otherwise, with the underlying mechanisms (sessionSync debug data, credential storage) completely unchanged.

## Explicitly deferred

Tier 2 (the Experience Layer: purple accent, reveal animation, winner celebration, dimming, glow, future sound/haptics) — held until a real playtest validates this Tier 1 baseline, per the agreed sequencing. When Tier 2 begins, each element is to be tracked individually as a hypothesis (hypothesis / expected emotional outcome / implementation / validation criteria / playtest observations / final decision), not implemented and kept by default.
