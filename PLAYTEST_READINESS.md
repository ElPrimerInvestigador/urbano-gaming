# Playtest Readiness — Level 33 Trivia (URBANO Gaming)

Practical summary for tomorrow night's real playtest. Technical detail lives in `SLICE_003_IMPLEMENTATION_RECORD.md`; this document is the "can I actually run this tonight" answer.

## What is ready

- Multi-question Multiple Choice trivia, prepared in advance, run one question at a time, scored automatically at reveal — no manual host scoring needed for trivia questions.
- Verified live, through the real interfaces, across a full 5-question game with mixed outcomes and a tie: correct next-question selection every time, no consumed question restartable, standings accumulating correctly after every single reveal, joint-winner banner appearing immediately for host and all participants at session end.
- Verified continuity: host can fully reload their browser mid-game and recover exactly where they left off (session, standings, revealed results). Same for participants — mid-question or after a reveal.
- Verified resilience to double-clicks: clicking "Start Next Question" or "Reveal Results" twice in a row does not create a duplicate question or double-award points — the second click is safely rejected.
- Verified that Open Response (the original format) still works completely unchanged, including manual host scoring, in its own separate session.
- Two real bugs found during this testing were fixed and reverified: a malformed answer submission used to crash with a generic server error (now returns a clear rejection); starting a second session in the same browser tab without reloading used to show the previous game's leftover questions and scoreboard for a moment (now starts clean).

## What remains limited (by design, not oversight)

- No timer on questions — the host controls pacing manually (start → let people answer → close → reveal, at their own speed).
- No partial credit, no multiple correct answers, no speed bonus — one correct option per question, full points or nothing.
- Once a question is saved to the queue, it cannot be edited or reordered — only added to. If you need to fix a typo, prepare a fresh question rather than editing.
- The "debug" panel at the bottom of each screen (raw JSON) is a developer leftover — harmless, ignorable, not something to explain to guests.
- No real logo yet — the "URBANO GAMING" wordmark is styled text, not an image. Cosmetic only.

## Setup requirements for tomorrow

1. **Start the app** from this folder:
   ```bash
   npm run dev
   ```
   Leave that terminal window open all night — closing it ends the game for everyone.

2. **Everyone must be on the same Wi-Fi network** as the host's laptop (this is a local dev server, not a public website). Find the host laptop's local address once Wi-Fi is connected — on a Mac:
   ```bash
   ifconfig | grep "inet " | grep -v 127.0.0.1
   ```
   Tonight it was `192.168.87.178` on this network — it may be different on your Wi-Fi tomorrow, so re-check.

3. **Host opens, on their own laptop**: `http://<that address>:3000/host.html` (e.g. `http://192.168.87.178:3000/host.html`).

4. **Each guest opens, on their own phone**: `http://<that address>:3000/participant.html` — same address, `participant.html` instead of `host.html`. Easiest way to share it: a QR code pointed at that URL, or just read the address aloud.

5. No installs, no accounts, no app downloads for guests — just that one URL in their phone's browser.

## Exact host steps, in order

1. Open `host.html`. Click **Create Session**. A room code appears — this is what you'll tell guests if you're not using a QR code (though guests actually need the full URL above, not just the code, unless you set up a landing page — simplest is: share the URL, they land on the join screen, *then* they type the room code shown on your screen).
2. **Before or while guests are joining**: use the "Trivia Questions" section to author your questions (see below for the fast way). Click **Save Questions** once you've added them — you can keep adding more later if you think of one mid-game.
3. Once your guests have joined (you'll see their names appear under Participants), click **Lock Lobby**.
4. Click **Start Next Question**. It automatically picks your next unused question, in the order you queued them.
5. Wait for guests to answer — you'll see "N of M submitted" update live. When ready (or everyone's answered), click **Close Submissions**.
6. Click **Reveal Results**. This is the fun moment — the correct answer highlights, everyone sees who got it right, and points are awarded automatically. Nothing more to click for scoring.
7. Repeat steps 4–6 for each remaining question. The button says **Start Next Question** as long as questions remain in the queue.
8. After your last question is revealed, click **End Session**. The winner (or joint winners, if tied) is announced immediately on every screen, including yours.

## Fastest way to enter your real questions

**Option A — just click through the form** (no tech comfort needed): type the question, fill in each option, click the circle next to the correct one, optionally set points (blank defaults to 10), click **Add to Queue**. Repeat per question, then **Save Questions** once at the end. Fine for a handful of questions; a bit repetitive for 15–20.

**Option B — paste them all in at once** (fastest if you're comfortable with a browser's DevTools console, and by far the best option if you're typing up more than ~5 questions): open the browser console on the host page (Right-click → Inspect → Console tab, or `Cmd+Option+J` on Chrome/Mac) and paste something like this, edited with your real questions, then press Enter:

```js
draftQuestions = [
  { promptText: "Your question here?", options: ["Right answer", "Wrong 1", "Wrong 2"], correctOptionIndex: 0, points: 10 },
  { promptText: "Another question?", options: ["A", "B", "C"], correctOptionIndex: 1, points: 15 },
  // ...as many as you want, one line per question
];
saveQuestions();
```
`correctOptionIndex` is the position of the right answer, counting from 0 (0 = first option, 1 = second, and so on). `points` is optional per question — leave it out and it defaults to 10. This does exactly what clicking through the form and clicking "Save Questions" would do — same validation, same result — just faster to prepare ahead of time in a text editor and paste in one shot.

Either way, review the "Question Queue" list that appears afterward to confirm everything saved correctly (including which answer is marked correct) before you start playing.

## If something goes wrong mid-game

- **A guest's browser needs to reload or their phone locks/unlocks**: this is safe. Reopen the same URL — they'll land back exactly where the game is, standings intact. No need to rejoin.
- **Your own host browser crashes or you accidentally close the tab**: reopen `host.html` at the same address — it remembers your session and picks up exactly where you left off. Don't click "Create Session" again unless you genuinely want to start a brand-new game.
- **A button seems unresponsive or you're not sure what happened**: click **Check for updates** — it's a safe, side-effect-free refresh you can click any time.
- **You clicked "Start Next Question" or "Reveal Results" and aren't sure if it registered**: safe to click again — a second click on an already-completed action is rejected harmlessly, it will not duplicate anything or double-score anyone. If you see a red message banner, that's just telling you the click didn't do anything new — not that something broke.
- **You want to skip a prepared question entirely**: there's no built-in "skip" — the queue always gives you the next unused one in order. If you truly need to skip one, the only way right now is to not click through to it (i.e., end the game before reaching it, or just play it anyway).
- **Total meltdown / you want to abandon this game and start fresh**: click **End Session**, then reload the page and click **Create Session** for a brand-new game with a new room code. Anyone still on the old room code will need the new one.
