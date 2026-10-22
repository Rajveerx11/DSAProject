# Recorded Pointer Simulation

[Back to README](README.md) · [API](API.md) · [Guided demo](GUIDED_DEMO.md)

Simulation displays a historical replay of real C operations. The collection shows committed state while the pointer canvas can show intermediate assignments. This is not a live CPU debugger, and replay does not mutate the backend.

## Using manual replay

1. Open Simulation and expand **Manual replay controls**.
2. Disable **Auto-play steps** to inspect an operation manually.
3. Perform Add, Select, Delete, Next/Previous, Reverse, or Merge.
4. Use **Previous step** / **Next step** to inspect the before snapshot and recorded events.
5. Use **Replay**, **Pause/Continue**, speed, or **Finish** to control the display.

The canvas labels the assignment, progress, visited comparisons, pointer writes, logical IDs, NULL links, and endpoint/current markers. Freed nodes can appear briefly as labelled ghosts. Reverse rearranges existing cards; merge moves existing IDs between lists without copying nodes.

A new mutation finishes the old display replay before requesting C work. Large traces with more than 80 events start paused. Reduced motion shows the final state immediately for ordinary autoplay, while manual inspection remains available. Guided sequencing is described separately in [GUIDED_DEMO.md](GUIDED_DEMO.md).

## Trace payload

Every successful state response includes `operation.trace`:

| Field | Meaning |
| --- | --- |
| `before` | Two copied playlist objects using the same shape as top-level `playlists` |
| `events` | Ordered events captured from synchronous C observers |
| `truncated` | Whether the capture limit was exceeded |

Event examples below illustrate individual shapes, not one complete operation:

```json
[
  {"kind":"allocate","playlist":"main","id":6,"title":"Track D","artist":"Sample","prev":null,"next":null},
  {"kind":"visit","playlist":"main","id":1},
  {"kind":"pointer","playlist":"main","id":6,"field":"prev","from":null,"to":3},
  {"kind":"pointer","playlist":"main","id":null,"field":"tail","from":3,"to":6},
  {"kind":"free","playlist":"main","id":6}
]
```

| Kind | When recorded | Fields beyond `kind` / `playlist` |
| --- | --- | --- |
| `allocate` | After allocation/metadata initialization, before linking | New `id`, `title`, `artist`, `prev`, `next` |
| `visit` | Immediately before an actual ID comparison in `playlist_find` | Compared `id` |
| `pointer` | At the actual C assignment | Owner `id`, `field`, old `from`, new `to` |
| `free` | After unlinking, before freeing memory | Removed `id` |

`playlist` is `main` or `secondary`. Numeric owner IDs identify node fields (`prev`, `next`); `id: null` identifies playlist fields (`head`, `tail`, `current`). Pointer values use IDs or null. An assignment can be recorded even when old and new values are equal. The visit count measures recorded ID comparisons, not every loop iteration in every algorithm.

## Frame model

For N events:

| Frame | Display |
| --- | --- |
| 0 | C-owned before snapshot |
| 1 through N | Before snapshot with the first k recorded events applied |
| N + 1 | Authoritative committed top-level playlists |

Intermediate reversal/merge/unlink writes may temporarily break list invariants, create cycles, or cross playlist boundaries. The frontend projects allocations by ID independently of list traversal. It uses the final snapshot for canonical order, size, and membership.

Frontend validation checks snapshot shape, bounds, allocation lifetime, pointer owner/target validity, old `from` values, and full-trace parity with final state. Truncated history is marked rather than represented as complete. Normal supported operations at the 200-song limit are expected to fit within 632 events and the 512 KiB response buffer; capacity tests exercise this boundary.

## Ownership and failure behavior

Before snapshots come from C immediately before capture, not from a potentially stale tab. Events own copied IDs/metadata and never expose raw or freed addresses. Invalid actions preserve the previous state and trace.

Initial/reset state uses an empty trace with `before` equal to the new committed sample state. Reset is explicitly a replacement; it does not fabricate allocation/free instructions for the old lists. Reset still uses fresh IDs within the running process.

## Validation map

- `tests/native.c`: pointer invariants, ownership behavior, observer behavior.
- `tests/trace.c`: actual event order, visited IDs, replay parity, copied snapshot lifetime, rejected/allocation-failure preservation, reset, full-capacity serialization.
- `web/check.cjs`: projection, invalid trace rejection, bounds, autoplay/reduced-motion policy.
- `tests/browser.cjs`: real C-backed frames, geometry, ghosts, replay controls, routing, responsive behavior, and focus expectations.

See [testing](docs/TESTING.md) for commands and the distinction between unit and real-browser validation.
