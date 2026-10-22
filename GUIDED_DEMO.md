# Demo View and Guided Simulation

[Back to README](README.md) · [Manual trace replay](SIMULATION.md) · [Presentation guide](docs/DEMONSTRATION.md)

## Two views, one C state

| View | Purpose | Audio |
| --- | --- | --- |
| `/#demo` (default) | Manual playlist management without pointer diagrams or technical ID labels | Explicit sample/local playback |
| `/#simulation` | Operation desk, pointer canvas, guided tour, optional manual replay/explanations | Silent |

Changing views preserves playlists. Unknown anchors such as the skip link preserve the established view. The guided tour starts idle and requires an explicit Start.

Desktop Simulation places controls on the left and replay on the right, with independently scrolling panes. On small screens, manual use stacks the sections. During a tour, a sticky toolbar remains available while the highlighted control and replay panes alternate; stopping/completing restores the stacked layout.

## Eight-action tour

**Start replaces both playlists with sample data.** The warning is visible beside the controls.

| Step | API action | Demonstration |
| --- | --- | --- |
| 1 | `reset` | Establish predictable sample lists with fresh IDs |
| 2 | `add` to main | Append “Guided Groove” by “Sample session” |
| 3 | `next` in main | Follow current.next |
| 4 | `previous` in main | Follow current.prev |
| 5 | `select` added ID | Traverse and compare IDs |
| 6 | `delete` added ID | Unlink and free the new node |
| 7 | `reverse` main | Swap node links and endpoints |
| 8 | `merge` secondary into main | Transfer source nodes and empty Side B |

The controller derives the new ID from C responses. It fills fields, highlights controls, and can show a decorative cursor; it does not move the OS cursor or intentionally take keyboard focus. Every step uses the normal request path and waits for successful C response plus recorded replay before advancing.

## Controls and cancellation

- **Start:** begin a fresh tour. Duplicate starts and competing mutations/manual replay are blocked while active or paused.
- **Pause / Resume:** hold future dispatch and replay. A request already in flight can still commit; its returned replay waits while paused.
- **Stop:** cancel future work and finish the display. It cannot undo an already accepted C action.
- **Speed:** 0.5×, 1×, 2×, or 4×; affects guided pacing and replay presentation.
- **View exit / page hide:** stop future guided actions. Returning does not restart automatically.
- **Failure:** halt and report an error. Refresh authoritative state after an uncertain response; restarting is explicit and resets again.

Reduced motion retains the ordered C requests and readable explanations while omitting moving cursor/FLIP and ordinary per-event animation. It does not replace C operations with simulated frontend changes.

## Browser audio lifecycle

Demo offers 12-second generated sample WAV melodies and an optional local file selected when adding a record. Files are associated with the actual returned node ID, including records added to Side B and later merged into Side A. C stores only metadata and links.

| Event | Audio behavior |
| --- | --- |
| Press Play | Explicitly start selected Side A preview; failures are reported |
| Select another record / navigate | Playback requires a new explicit Play |
| Reverse / merge | Associations follow stable IDs |
| Delete current / reset | Stop obsolete audio and release removed associations |
| Enter Simulation / hide page | Pause playback |
| Refresh unchanged C state | Preserve source and playback position |
| Reload / real page exit | Discard browser-local associations and release blobs |
| Back/forward-cache restoration | Can retain associations, refresh C state, and remain paused |

Unsupported files show an error; select another record or reset to recover. Local files are never uploaded. A historical reset label returned by GET is not a new reset; reconciliation uses actual IDs/membership/metadata.

## Frontend integration reference

| Element / state | Role |
| --- | --- |
| `body[data-view]` | Active Demo/Simulation view |
| `#view-demo`, `#view-simulation` | Hash navigation with current-page state |
| `#pointer-lab`, `#guided-demo` | View-dependent simulator/tour sections |
| `#guided-start`, `#guided-pause`, `#guided-stop`, `#guided-speed` | Guided controls |
| `#guided-demo[data-status]` | `idle`, `running`, `paused`, `stopped`, `complete`, or `error` |
| `#guided-status`, `#guided-progress` | Polite status and eight-step progress |
| `#manual-replay-details` | Initially closed manual replay disclosure |
| `#audio`, `#play-pause`, `#volume`, `#audio-file` | Browser-only playback controls |
| `body[data-tour-phase]` | Small-screen controls/replay presentation phase |

Pure controller/audio/projection checks are in `web/check.cjs`. Actual media decoding, pointer geometry, tours, responsive layouts, cancellation, and focus expectations are exercised by the browser suite. See [TESTING.md](docs/TESTING.md).
