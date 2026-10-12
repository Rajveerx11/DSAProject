# Side-by-side simulation update

## Acceptance
Keep the established paper/ink/vermilion musiclab look. Desktop becomes an operation desk on the left and an always-visible, sticky pointer simulator on the right. On small screens use a usable stacked layout. Remove real audio/file/volume requirements: this is a silent playlist simulation with sample labels. C still performs every linked-list operation.

The focal interaction is an operation replay: C-recorded node visits and pointer assignments illuminate cards/edges in order. Insert materializes a node; delete unlinks/removes it; navigation moves current; reverse rewires links then visibly rearranges node cards; merge connects and transfers Side B cards. Provide Auto-play steps, Pause/Continue, Previous step, Next step, Replay, Finish, and speed controls. Allow new operations by finishing the old replay rather than queuing stale clicks. Reduced motion shows an immediate final frame, but manual steps remain available. Clean up timers/animations on replay replacement and page hide. Never steal intentional keyboard focus.

Show the active assignment, comparison/visit count, progress, highlighted source/target, NULL/head/tail/current, and backend complexity. Labels explicitly distinguish historical/intermediate replay from committed C state. The graph is a display projection of recorded events, not a JS implementation of playlist algorithms. Geometry movement uses Web Animations/FLIP and directed SVG arrows; no animation library/runtime dependency. For long lists scroll internally and keep the active event visible.

## Shared trace contract
Preserve existing response and action fields. Add `operation.trace`:

```json
{
  "before": ["same two playlist objects/shapes as top-level playlists, copied before mutation"],
  "events": [
    {"kind":"allocate","playlist":"main","id":6,"title":"Track D","artist":"Sample","prev":null,"next":null},
    {"kind":"visit","playlist":"main","id":1},
    {"kind":"pointer","playlist":"main","id":6,"field":"prev","from":null,"to":3},
    {"kind":"pointer","playlist":"main","id":null,"field":"tail","from":3,"to":6},
    {"kind":"free","playlist":"main","id":6}
  ],
  "truncated": false
}
```

- `playlist` is `main` or `secondary`.
- Node pointer events: numeric `id`, field `prev`/`next`. Playlist pointer events: `id: null`, field `head`/`tail`/`current`. From/to IDs or null.
- Visit emitted immediately before each actual ID comparison in C. Pointer event recorded at the corresponding actual C assignment. Allocate is emitted after successful allocation/metadata initialization, before linking. Free emitted before freeing.
- Before snapshots must come from C, not the browser's possibly stale previous state. Final top-level playlists remain authoritative. After the last event, UI uses that final snapshot for canonical membership/order/size. During intermediate merge/reverse frames, render allocation records independently of traversal to avoid cycles; cross-list links may be temporarily visible.
- Optional observer/callback around existing DLL functions is acceptable; keep their algorithms readable and unchanged when tracing is disabled. Avoid duplicating linked-list algorithms in the API or frontend. Avoid redundant search passes where practical.
- Capture only accepted operations. Invalid requests must preserve previous state AND trace. Initial/reset traces may be empty if `before` equals the final initial state and reset is explicitly a committed replacement, not fabricated free/allocate instructions.
- Bound events to at least `3 * SONG_LIMIT + 32`, and report truncation honestly. Normal allowed operations up to 200 nodes must not truncate. Keep response capacity sufficient for worst-case escaped before+after metadata and trace (512 KiB is sufficient with compact events); test it.

## Isolation / ownership
Backend worktree: src/ and tests/native.c only; add tests/trace.c if useful and update Makefile only for that native target. Frontend worktree: web/ only, including check.cjs. Manager owns integration, API/browser regression tests, docs and CI. Both agents load Ponytail. Frontend also loads Frontend Design; preserve visual language. No agent pushes, merges, resets, or edits another worktree.

## Verification
Trace tests must prove actual pointer-event order, visited IDs, snapshot ownership/lifetime, invalid-operation preservation, reset semantics, before/after parity, and full occupancy capacity. Existing native/API/sanitizer tests remain. Update browser tests for the deliberate removal of audio and add desktop left/right geometry, live intermediate versus final frames, insertion/deletion/reverse/merge/navigation, pause/step/replay/finish/speed, replacement/interruption, reduced motion, keyboard and pending-focus behaviour, safe long metadata, responsive screenshots and no console errors. Restart the owned demo server on port 8081 after validation; verify Musiclab UI and API content from Windows, not just HTTP 200.
