# Submission and Demonstration Guide

[Back to README](../README.md) · [Architecture](ARCHITECTURE.md) · [Testing](TESTING.md)

## Before submission

- Build and run the submitted checkout using the README commands.
- Run `make check` and `make sanitize`; run browser tests when tooling is available. Record actual outcomes, including failures and unrun checks.
- Check that the README architecture diagram renders on GitHub and that local documentation links work.
- Keep source, tests, Makefile, workflow, and docs in the submission. Exclude generated binaries, browser packages, local audio, credentials, and machine-specific files.
- If the institution requires a report/cover sheet, add the actual student names, roll numbers, course, faculty, and institution there. These details are not inferred by this repository.
- Capture screenshots from the submitted version if required: Demo, Simulation, one intermediate assignment, and a final reverse/merge state. Label historical versus committed state accurately.

The repository documents the software; follow any separate institutional format and submission requirements supplied by your course.

## Ten-minute presentation

| Time | Demonstration | Explanation |
| --- | --- | --- |
| 0–1 min | Introduce the playlist problem and architecture | C owns nodes; browser displays state and history |
| 1–3 min | Demo: select, Play, add, Next/Previous | Distinguish metadata from browser-only sample/local audio |
| 3–5 min | Simulation: Start, pause on an assignment | Start resets sample data; events come from actual C operations |
| 5–6 min | Manual add/delete, inspect links | Explain current replacement and reciprocal links |
| 6–7 min | Reverse A | Same nodes/current, swapped prev/next and endpoints |
| 7–8 min | Merge B into A | Ownership transfers; B empties without copying IDs |
| 8–10 min | Show structs/functions and test commands | Explain complexity, memory cleanup, and scope limits |

Prepare the app with `make` and `./build/musiclab --port 8081` from the root. Use generated samples for a demonstration without external media. Simulation itself is silent. **Reset and guided Start replace existing playlists.**

## Suggested manual evidence

1. Reset: confirm Side A has three records and Side B has two.
2. Disable Auto-play steps, add to A, and inspect allocation, tail links, and final state.
3. Select the added record and inspect visits before current changes.
4. Delete it; explain why current moves to next, else previous, else NULL.
5. Reverse A; confirm the same selected ID remains current while order changes.
6. Merge B into A; confirm source empties and transferred IDs remain unchanged.
7. Demonstrate a boundary Next/Previous: a successful no-op rather than circular wrapping.

Manual replay changes only display position. Intermediate frames may temporarily violate invariants; the final committed C state must satisfy them.

## Viva questions

| Question | Key point |
| --- | --- |
| Why a doubly linked list? | Previous and Next are O(1) from current; a singly linked list needs a scan for previous |
| Why store tail? | Append and concatenation avoid traversal |
| Why is deletion by ID O(n)? | Finding the node is O(n); unlinking a known node is O(1) |
| What changes in reverse? | Each node swaps prev/next, endpoints swap, current remains the same node |
| What prevents dangling current? | Update it before freeing the selected node |
| What happens during merge? | Link existing endpoints, transfer ownership, clear source pointers/size |
| How are empty lists represented? | Null endpoints/current, size zero |
| What does the ID represent? | A process-scoped logical identity, not an address or persistent key |
| Does JavaScript implement a second list algorithm? | No; it projects C snapshots/events for display |
| Are visit counts invented? | No; observers record comparisons in the actual C ID search |
| Is replay live debugging? | No; C has committed before the response and animation |
| Why is a merge request still O(n)? | Full snapshots/events are copied, serialized, transmitted, and rendered |
| How is memory checked? | Invariant/cleanup tests plus ASan, UBSan, and leak detection |
| What survives restart? | No playlist state; persistence is outside scope |
| Where are audio files stored? | Only in browser memory/blob associations; never uploaded to C |

## Code-reading route

Start with `src/playlist.h`, then `playlist_add`, `playlist_find`, `playlist_delete_node`, `playlist_move`, `playlist_reverse`, `playlist_merge`, and `playlist_clear` in `src/playlist.c`. Next inspect API capture/serialization in `src/api.c`, transport dispatch in `src/server.c`, and projection/controller functions in `web/app.js`.

For evidence, show native invariants and trace parity checks before discussing UI animation. Clearly distinguish tests that actually ran from coverage that exists in the suite.
