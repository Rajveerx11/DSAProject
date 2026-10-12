# Music Player & Doubly Linked List Lab — Delivery Plan

## Goal
Build a polished, local music playlist manager for a second-year DSA demonstration. C owns every playlist node and pointer mutation; HTML/CSS/JavaScript provides playback controls and a toggleable live linked-list visualizer. No Python backend or JavaScript imitation of the linked list.

## Scope and architecture
- C: `SongNode` with stable ID, title, artist, `prev`, and `next`; `Playlist` with `head`, `tail`, `current`, and size. Implement create/add, delete, select, next/previous, display, reverse, concatenate, and cleanup.
- Maintain two playlists. Concatenation transfers nodes to the destination and empties the source without copying songs. Define current-song behaviour for empty lists, boundary navigation, and deletion.
- A small loopback-only C HTTP server serves `web/` and an API. Bound input sizes, validate requests, escape JSON, allowlist static paths, and reject cross-origin mutations. Keep transport code separate from syllabus algorithms.
- API: `GET /api/state`; `POST /api/action` with URL-encoded fields (`action`, `playlist`, and action-specific values). JSON responses carry authoritative state, node identifiers/links, operation explanation, and changed-node identifiers. Errors preserve state.
- UI: responsive player, two playlists, labelled forms, keyboard-accessible controls, actual browser audio with clearly labelled local/demo sources, empty/loading/error states, and a DSA-view toggle.
- Visualizer: display `NULL`, `head`, `tail`, `current`, node IDs, and bidirectional links. Animate returned operation changes; explain that these are logical identifiers, not memory addresses or a debugger stepping through C.
- Style direction: a restrained record-deck lab, warm paper/ink palette, one vivid accent, readable type, purposeful pointer highlights, and reduced-motion support. No framework or runtime npm dependencies.
- State is in memory for one local classroom session. No accounts, database, internet streaming, production deployment, or multi-user isolation.

## Delivery phases
1. Resolve Git identity, repository destination/visibility, remote authentication, local OCR tooling, and project instructions. Preserve existing state; do not invent an origin.
2. Initialize the empty project if needed; commit the plan on `main`; create an integration feature branch.
3. Create dedicated Git branches and worktrees for two independent implementation agents:
   - Backend agent owns C sources/headers, native/API tests, and Makefile. Use Ponytail; manually implement the doubly linked list; validate pointer invariants and memory cleanup.
   - Frontend agent owns `web/` and frontend assets/helpers. Use Ponytail and Frontend Design; consume the agreed API without duplicating linked-list logic.
   Agents must commit only owned files, run scoped checks, and never push, merge, reset user state, or change another worktree.
4. Integrate focused commits; add README/demo/viva notes and CI; run native tests, sanitizers, API negative tests, JavaScript checks, and real browser interaction/responsive checks.
5. Publish one PR using Task to PR. Use local OpenCodeReview (OCR), not CodeRabbit. Review every actionable finding, fix valid issues, rerun checks, and repeat review on the latest changes. Use a separate review-only worktree/agent if useful.
6. Wait for applicable CI. Merge only after implementation, review, and checks are clean, as explicitly authorized by the user. Verify remote `main` contains the merged commit.
7. Remove only task-created temporary worktrees and obsolete branches; prune references; leave a clean repository. Record exact verification and any genuine blocker.

## Acceptance and validation
- Both UI sections stay synchronized with C's state for every operation.
- Demonstrate add, middle/head/tail/current deletion, boundaries, reverse, concatenate, empty playlists, and long/escaped song names.
- Verify `head->prev == NULL`, `tail->next == NULL`, reciprocal links, size, forward/backward traversal, and valid current pointer after each mutation.
- Explain next/previous and append with tail: O(1); search/delete by ID and reverse: O(n); concatenate with maintained endpoints: O(1); stored nodes: O(n).
- Compiler warnings treated as errors; native tests and AddressSanitizer/UndefinedBehaviorSanitizer; bounded/invalid HTTP/API inputs; `node --check`; browser flows at desktop/tablet/mobile, keyboard focus, reduced motion, and console/network errors.
- README includes build/run commands, supported platform (Linux/WSL), API, limitations, algorithm walkthrough, 10-minute demo script, and viva prompts.

## Initial checkpoint
- Workspace: `/mnt/c/DSAProject`; empty and not yet a Git repository.
- GitHub CLI: Windows `gh.exe`, authenticated as `Rajveerx11`.
- OCR: installed OpenCodeReview CLI; review configuration not yet verified.
- Existing public repository search found no matching DSA/music repository. Remote destination and visibility still need resolution before publication.
- User explicitly replaced CodeRabbit review with local OCR and authorized eventual merge and cleanup.
