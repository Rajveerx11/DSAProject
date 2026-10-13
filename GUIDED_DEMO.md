# Demo + guided simulation update

## Acceptance
- No changes to C linked-list code, API or server/static routes.
- One dependency-free HTML shell, two real hash-routed views: `/#demo` (default) and `/#simulation`. Preserve state on navigation; unknown anchors such as the skip link must not unexpectedly switch an established view.
- Demo: usable, polished manual playlist UI only. Hide pointer canvas, replay controls and pointer-ID technical metadata; keep Add/Delete/Select/Next/Previous/Reverse/Merge/Reset.
- Simulation: existing left operation desk/right real C-recorded pointer replay plus a one-click guided demonstration. Default idle; Start is explicit and warns that it resets both playlists to sample data.
- Guided sequence: C reset -> add sample to main -> next -> previous -> select the added ID -> delete that ID -> reverse main -> merge secondary into main. Derive IDs from C responses, never hardcode them. Visually fill relevant fields and highlight controls with an optional decorative cursor/press effect; no actual OS cursor or forced keyboard focus.
- Every action uses the existing requestState/API path and waits for successful C response and its replay completion before the next action. No JavaScript implementation of linked-list operations or invented traces.
- Start/Pause-or-Resume/Stop/Speed, progress and explanatory status. Prevent duplicate Start and competing manual/replay inputs while running or paused. Changing speed settles geometry correctly. Reduced motion retains the guided sequence and explanations but skips cursor/FLIP animation.
- Pause holds subsequent actions and replay; Stop/view exit/page hide cancels future scheduled work without undoing or duplicating already accepted C mutations. Handle in-flight requests honestly, use the existing pending/abort/reconnect semantics. Failures halt rather than falsely reporting completion. Restart is explicit and resets via C again.

## Shared DOM contract
- `body[data-view="demo"]` initially; app.js changes to `simulation` as needed.
- Navigation anchors `#view-demo` href `#demo`, `#view-simulation` href `#simulation`, with current `aria-current="page"` updated in JS.
- Existing `#pointer-lab` initially `hidden`; JS toggles hidden with view. `#guided-demo` initially hidden; JS toggles with view.
- Guided controls: `#guided-start`, `#guided-pause`, `#guided-stop`, `#guided-speed` (0.5, 1, 2, 4; default 1), `#guided-status` (polite status), `#guided-progress` (progress element, max 8), `#guided-reset-note` (visible reset warning).
- Decorative `#guided-cursor` initially hidden and aria-hidden, fixed positioning, pointer-events none. CSS `.guided-target` highlight and `.guided-pressed` press effect, reduced-motion equivalent. JS positions cursor without stealing focus.
- Retain all existing player/replay/diagram IDs and data attributes, no additional asset script (C allowlist unchanged).
- DOM status/progress should expose idle/running/paused/stopped/complete/error through `#guided-demo[data-status]` for assertions. Guided controller owns this and locks controls through existing updateControls.

## Latest user steering: audible Demo and simpler Simulation
- Demo needs a prominent `#play-pause` button and actual sound. Browser-only generated **sample tones** are clearly labelled (not claimed as real licensed songs); optional local audio chosen when adding a record plays via blob URLs associated with C-returned IDs. C code/static routes remain unchanged.
- Shared audio DOM: `#audio` (audio element, preload metadata, hidden native element), `#play-pause`, `#audio-status` (polite status), `#audio-file` (optional file input, accept audio/*), `#volume` (0..1 range, default .7). Play is explicit user gesture; report playback errors, pause when entering Simulation, keep selection/navigation/deletion/reset coherent, clean up unused blob URLs. No internet streaming or uploads to C.
- Simplify Simulation: compact guided toolbar with Start/Pause/Stop/Speed, brief visible reset warning and progress; compact replay status/current assignment/counters; show manual replay controls in `#manual-replay-details` (details disclosure, closed initially). Preserve existing replay IDs. Additional C steps/complexity may be under a details disclosure. Keep factual C-history/ID distinction visible concisely.
- Critical regression from independent review: active pointer card/fields must remain fully visible at 768x768 and 1024x600, not just 1440x1000. Compact guide and inspector or adapt layout so a full 140px card plus gutters fits; panning alone cannot fix insufficient space.
- View/audio agents stay isolated; audio agent owns only app.js/check.cjs, view agent owns only index.html/styles.css. Manager updates browser tests/docs and integrates. Prior silent-only assertions/docs must be updated honestly.

## Isolation and ownership
- View agent: only `web/index.html`, `web/styles.css`; Ponytail + Frontend Design, preserve incumbent paper/ink/vermilion visual language. No JS or C edits.
- Controller agent: only `web/app.js`, `web/check.cjs`; Ponytail, route handling and sequential guided controller reuse existing functions. No HTML/CSS/C edits. Existing unit fixtures retained.
- Manager: integration, real browser tests, documentation, CI/review/publication, merge under standing user authorization, cleanup. Independent local OCR-delegated reviewer gets its own branch/worktree.

## Validation
`make check`, focused browser suite (existing simulation regression plus default demo route, refresh/history, single-click complete guided sequence, actual ordered POSTs and C state/trace parity, duplicate-start, pause/resume, stop/view exit, network/validation failure, reduced motion, responsive screenshots). Confirm C tree exactly unchanged against main. Sanitizers already cover unchanged C; CI reruns them. Independent OCR-delegated review, address actionable findings, commit/push one PR, wait for CI, verify merged main and clean task worktrees/branches. Keep Windows-accessible demo at localhost:8081; do not touch EDB on 8080.
