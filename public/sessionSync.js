/**
 * Slice 004 (Passive Session Synchronization).
 *
 * A minimal, session-agnostic polling lifecycle — this file has no
 * knowledge of sessions, GET_SESSION, or error types. It exists so
 * host.html and participant.html consume one shared implementation
 * instead of each owning an independent timer, per the accepted
 * design: this is a synchronization *capability*, not two parallel
 * polling loops that happen to look alike.
 *
 * createSessionSync(onTick, intervalMs) returns { start, stop, pause,
 * resume, refreshNow, getStatus }. The caller supplies onTick —
 * whatever "refresh now" already means on that page (hostRefresh /
 * participantRefresh), returning its promise — and this module only
 * ever decides *when* to call it, never *how*.
 *
 * stop() is a deliberate, one-way action for the remaining lifetime of
 * this page load (used by callers for a terminal error, or once the
 * session reaches SESSION_COMPLETE). Recovery from it is a page
 * reload, or an explicit start() call from the caller (e.g. creating a
 * new session) — never an automatic lifecycle event.
 *
 * refreshNow() bypasses every gate — a manual refresh ("Check for
 * updates") is a deliberate user action and must always work as a
 * recovery tool.
 *
 * --- Correction 1 (real-phone backgrounding) ---
 * The first version trusted its own `timer` handle across a
 * background/foreground cycle. A real phone can silently invalidate a
 * running interval while backgrounded (no callback, no error), leaving
 * `timer` non-null but dead; `resume()` saw "not null" and never
 * replaced it. Every "became active" path now unconditionally tears
 * down whatever handle exists and creates a fresh one — see
 * recreateTimer(). `pageshow` and `focus` were added alongside
 * `visibilitychange`, since the latter alone did not reliably cover
 * every path a mobile browser uses to bring a page back.
 *
 * --- Correction 2 (the real root cause of "sync never runs at all") ---
 * Adding `pageshow` introduced a race that correction 1 did not
 * anticipate: `pageshow` fires on *every* page load, not only
 * back-forward-cache restoration — including the very first load,
 * before the host has created a session or the participant has
 * joined one. With `stopped` defaulting to `false`, that first
 * `pageshow` called `resume()` immediately, which ticked *before
 * start() had ever been called* — firing a GET_SESSION request
 * against a session that does not exist yet. That request's response
 * can arrive *after* the real, legitimate start() (from
 * createSession()/joinSession() moments later) — and if the caller's
 * refresh function treats "session not found" as terminal and calls
 * stop(), that stale, irrelevant response silently kills the sync
 * loop that had only just legitimately started. Manual refresh kept
 * working throughout (refreshNow() bypasses every gate), which is
 * exactly the reported symptom: everything works except automatic
 * sync, with no visible error.
 *
 * Fixed with a `started` flag, distinct from `stopped`: lifecycle
 * events (`resume()`) are no-ops until the caller has explicitly
 * called start() at least once. A page that has never started
 * anything has nothing for a lifecycle event to resume. This is the
 * module's responsibility because it is the one thing this
 * session-agnostic file can know for certain — whether its own
 * start() has ever actually been invoked — without needing to know
 * anything about sessions.
 *
 * A second, related hazard — an in-flight tick's response resolving
 * *after* a newer one has superseded it (e.g. after a new session was
 * created while an old tick was still in flight) — is guarded against
 * here by never overlapping ticks (see `ticking`), and guarded against
 * at the caller level (host.html / participant.html now check that
 * the session they asked about is still the current one before acting
 * on the response) since only the caller knows what "current" means.
 */
function createSessionSync(onTick, intervalMs) {
  intervalMs = intervalMs || 2000;
  let timer = null;
  let stopped = false;
  let started = false;
  let ticking = false;

  // Temporary diagnostic logging for the real-device investigation —
  // safe to remove once mobile behavior has been confirmed stable
  // across a normal playtest.
  function log(message) {
    console.log("[sessionSync] " + message);
  }

  function tick() {
    if (stopped || ticking) return;
    ticking = true;
    let result;
    try {
      result = onTick();
    } catch (e) {
      ticking = false;
      throw e;
    }
    Promise.resolve(result).then(
      function () { ticking = false; },
      function () { ticking = false; }
    );
  }

  // Unconditionally replaces whatever timer handle currently exists.
  // Never trusts `timer !== null` as proof the interval is still
  // live — see Correction 1 above.
  function recreateTimer() {
    if (timer !== null) {
      clearInterval(timer);
    }
    timer = setInterval(tick, intervalMs);
  }

  function start() {
    log("start()");
    started = true;
    stopped = false;
    recreateTimer();
  }

  function stop() {
    log("stop()");
    stopped = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function pause() {
    log("pause()");
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  // Guarded by `started`, not just `stopped` — see Correction 2
  // above. A lifecycle event has nothing to resume until the caller
  // has explicitly started this at least once.
  function resume() {
    log("resume() [started=" + started + " stopped=" + stopped + "]");
    if (!started || stopped) return;
    tick();
    recreateTimer();
  }

  function refreshNow() {
    log("refreshNow()");
    onTick();
  }

  function getStatus() {
    return {
      started: started,
      stopped: stopped,
      hasActiveTimer: timer !== null,
      ticking: ticking,
    };
  }

  function handleBecameActive(source) {
    log("became active via " + source + " (document.hidden=" + document.hidden + ")");
    if (!document.hidden) {
      resume();
    }
  }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      log("visibilitychange -> hidden");
      pause();
    } else {
      handleBecameActive("visibilitychange");
    }
  });

  window.addEventListener("pageshow", function (event) {
    handleBecameActive("pageshow(persisted=" + event.persisted + ")");
  });

  window.addEventListener("focus", function () {
    handleBecameActive("focus");
  });

  return {
    start: start,
    stop: stop,
    pause: pause,
    resume: resume,
    refreshNow: refreshNow,
    getStatus: getStatus,
  };
}
