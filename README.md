# Musiclab — records & pointers

A playlist manager with browser audio previews and a silent side-by-side **doubly linked list simulator** for a second-year DSA demonstration. C owns the nodes and records actual visits and pointer assignments. HTML, CSS, and JavaScript replay that trace with moving blocks and directed arrows.

## Run

Supported: Linux or Windows through WSL. You need a C11 compiler and Make; Node.js 18+ is needed for validation, not for running the app. No Python, framework, database, or runtime npm packages.

```sh
make
./build/musiclab --port 8081
```

Open **http://localhost:8081** in your browser. Run from the repository root so the server can find `web/`. Stop with Ctrl+C. Port 8080 may already belong to Windows EDB/Postgres; use an unused port in both Windows and WSL. Without `--port`, the C server defaults to 8080.

From Windows PowerShell, execute these as separate commands (older PowerShell does not support `&&`):

```powershell
wsl.exe --cd /mnt/c/DSAProject -- make
wsl.exe --cd /mnt/c/DSAProject -- ./build/musiclab --port 8081
```

The server binds only to loopback. This is a single-process, serial classroom application, **not a production web server** or an authenticated multi-user service. Do not expose it to the internet.

## Demo and simulation views

- **Demo** (`http://localhost:8081/#demo`, also the default root page): manual playlist UI without pointer diagrams or node-ID metadata. The prominent **Play/Pause** button plays the selected Side A record, with a Volume slider. Default previews are 12-second generated sample melodies, **not recordings of the named songs**. To play actual music, attach your own supported audio file in **Local audio** when adding a record; select that record in Side A and press Play. Files added to Side B keep their association when merged into A.
- Playback always needs an explicit Play after changing selection. Deleting current/reset stops its audio; entering Simulation or hiding the page pauses playback. Local files never leave the browser and associations disappear on reload, deletion or reset. Unsupported files show a readable error; select another record or reset to recover.
- **Simulation** (`http://localhost:8081/#simulation`): left operation desk and right C-recorded pointer canvas. Navigation preserves C state; it does not reset the playlists. Desktop panes scroll independently to keep guided controls visible; small screens stack the sections.
- Click **Start →** once for eight automatic real C actions: Reset → Add → Next → Previous → Select the added record → Delete it → Reverse A → Merge B into A. Fields fill automatically, a decorative cursor moves to highlighted controls, and every C-recorded frame completes before the next action. No OS cursor or keyboard focus is taken over.
- **Start replaces both playlists with sample data**, as the visible warning states. Use **Pause/Resume**, **Stop** and guided **Speed** to control the tour. A new Start is explicit; duplicate starts and competing manual/replay operations are blocked while a tour is active or paused. Stop/view exit/page hiding prevents future actions but cannot undo a C request already sent. Request failures halt the tour; refresh after an uncertain response before restarting.
- Reduced motion keeps the guided action sequence and readable explanations but omits moving cursor/FLIP and per-event playback. Manual frame inspection remains available after the tour.

### Manual simulation

- **Left:** current record, Add, Next/Previous, both playlists, Delete, Reverse, Merge, and Reset. This collection always displays committed C state.
- **Right:** recorded pointer replay and operation explanations. The guided tour is idle until Start, so individual operations can still be demonstrated manually.
- The demo starts with three sample records in **My playlist** and two in **Side B**. Simulation remains silent; no audio files are needed.
- An operation automatically replays actual C allocation, comparison/visit, pointer-write, and free events. Watch `prev`, `next`, `head`, `tail`, and `current` change, one recorded assignment at a time.
- Open **Manual replay controls** below the diagram to use **Pause/Continue**, **Previous step**, **Next step**, **Replay**, **Finish**, and **Speed**. **C explanation & complexity** is another optional disclosure, keeping the default tour uncluttered. Disable **Auto-play steps** for a viva-style manual walkthrough. Large traces (>80 events) start paused. Reduced motion immediately shows final state, while manual steps remain available without motion.
- Reverse visibly rearranges the same node blocks; Merge connects and moves Side B blocks into A without copying their IDs. Deleted allocations appear briefly as labelled freed ghosts.

C commits before the animation begins. The right pane explicitly labels intermediate/historical frames: they are recorded history, not live CPU debugging. Intermediate pointer writes can temporarily break list invariants; only the final frame is the canonical committed state. Node IDs are logical identifiers, not memory addresses. Replay affects display only and does not mutate C or execute a separate JavaScript linked-list algorithm. Another tab's changes appear after **Refresh state**; every operation's before snapshot comes from C rather than a possibly stale browser snapshot.

### Defined behaviour

- First insertion sets head, tail, and current to the new node.
- Deleting current chooses its next node, otherwise its previous node, otherwise NULL.
- Reverse keeps the same current song while exchanging each node's links and the list endpoints.
- Merge transfers existing nodes without copying them and empties the source. The destination keeps current unless it was empty; then it inherits the source's current.
- IDs are process-wide and never reused during that server process, including after reset.
- There are at most 200 songs across both playlists. Title and artist must be non-empty valid UTF-8, at most 127 bytes each, with no control characters. The backend trims ASCII spaces.

C state lives in RAM and disappears when the server stops. Initial titles/artists are sample labels; generated preview melodies do not represent those songs. Optional audio is a browser-only blob associated with a C-returned ID. No file uploads to C, persistence, or internet streaming.

## Where the DSA lives

| Path | Responsibility |
|---|---|
| `src/playlist.h`, `src/playlist.c` | Node structs, manual pointer operations, allocation and freeing |
| `src/api.h`, `src/api.c` | Validate commands; copy before state; capture and serialize real C events |
| `src/server.c` | Loopback HTTP adapter and allowlisted static files |
| `web/index.html`, `web/styles.css` | Accessible responsive player and pointer-lab layout |
| `web/app.js` | Browser-only sample/local audio, hash views, guided requests, safe C-trace projection, arrows and animations |
| `tests/native.c`, `tests/trace.c`, `tests/api.mjs`, `web/check.cjs` | Pointer invariants, trace order/parity/lifetime/capacity, API, and projection checks |
| `API.md`, `PLAN.md`, `SIMULATION.md`, `GUIDED_DEMO.md` | API, delivery plan, recorded replay and guided-view contracts |

```c
typedef struct SongNode {
    uint32_t id;
    char title[128], artist[128];
    struct SongNode *prev, *next;
} SongNode;
```

Each playlist tracks `head`, `tail`, `current`, and `size`. It is **not** a C array or a Python/JavaScript list. The JSON array is only a transport snapshot created by traversing C's nodes.

### Operations and complexity

Let n be the number of nodes involved. These are costs of the linked-list operations, not the complete HTTP request:

| Operation | Time | Explanation |
|---|---|---|
| Append | O(1) | Tail is already known |
| Next / Previous | O(1) | Follow one current-node link |
| Search / Select by ID | O(n) | Traverse until ID is found |
| Delete by ID | O(n) | Search; unlink and free are O(1) once found |
| Display / serialize | O(n) | Visit every node |
| Reverse | O(n) | Swap prev/next on every node; swap endpoints |
| Concatenate | O(1) | Connect endpoints; transfer ownership and size |
| Clear | O(n) | Free every node |

Stored nodes use **O(n)** space; the underlying pointer operations use **O(1)** auxiliary space. Educational before snapshots and traces add **O(n)** storage. Every API response copies/serializes both lists and events, so full request/response time is **O(n)** even for an O(1) mutation. Rendering an individual replay frame is linear in records/events; replaying all frames is presentation overhead, not the algorithm's complexity.

### Pointer invariants

For every nonempty list: `head->prev == NULL`, `tail->next == NULL`, neighbouring links agree in both directions, size equals node count, and current belongs to that list. For an empty list, head/tail/current are all NULL and size is zero. Tests assert these after operations, including merges and deletion of current.

## Validate

```sh
make check       # warning-clean C build, native/trace/API tests, JS syntax and projection checks
make sanitize    # native + trace + API tests with ASan, UBSan, and leak detection
```

Individual checks:

```sh
make test
make test-api
node --check web/app.js
node web/check.cjs
```

API tests own ephemeral ports, child processes, and temporary fixtures; they do not modify the real UI. They cover invalid actions/IDs, UTF-8 and byte bounds, escaped metadata, body/header limits, request framing, Host/Origin restrictions, static-path allowlisting, deadlines, and disconnects. CI runs `make check` and `make sanitize` on Ubuntu.

For repeatable real-browser tests, install optional Playwright tooling outside the project:

```sh
npm install --prefix /tmp/musiclab-browser-tools --no-audit --no-fund playwright@1.56.1
node /tmp/musiclab-browser-tools/node_modules/playwright/cli.js install chromium
NODE_PATH=/tmp/musiclab-browser-tools/node_modules make test-browser
```

If Chromium needs system libraries, use Playwright's `install --with-deps chromium` command. Alternatively set `CHROMIUM_PATH` to an existing Chromium executable. The test owns an ephemeral C server and closes it on completion. It covers native sample/local audio decoding and nonzero output samples, playback lifecycle and pending file edits, full active-card/control visibility through real tours at 768×768 and 1024×600, plus actual C-recorded frames and arrow geometry, visits, allocation/free ghosts, manual replay, Demo/Simulation routing and state preservation, the ordered eight-POST guided sequence and all recorded frames, visible control highlights, duplicate Start, pause/resume/stop/speed, in-flight acceptance and view exit, failure/no-retry, keyboard focus, reduced motion and both-view responsive layouts. Screenshots default to `/tmp/musiclab-simulator-evidence`; override `MUSICLAB_EVIDENCE` if needed. CI runs these checks and uploads screenshots. This vanilla JavaScript project has no TypeScript typecheck or bundler build step.

## Ten-minute demonstration

1. **0–1 minute — Problem:** Explain why a playlist needs forward/back navigation and why a doubly linked list fits.
2. **1–3 — Demo first:** Use the Demo view to add/select records and navigate Next/Previous without diagrams. Then open Simulation and press Start tour for the hands-off walkthrough; pause to explain a C-recorded pointer assignment.
3. **3–5 — Insert/delete:** Add a song; inspect old/new tail links. Delete a middle node, then current; show the replacement current.
4. **5–7 — Reverse:** Keep the current song selected; reverse and show exchanged links/endpoints.
5. **7–8 — Concatenate:** Merge Side B; verify IDs stay unchanged and source becomes empty.
6. **8–10 — Code/viva:** Show `playlist_add`, `playlist_delete`, `playlist_reverse`, `playlist_merge`; explain complexity, memory ownership, and empty-list cases.

### Viva prompts

- Why doubly rather than singly linked? Previous is O(1) from current; singly linked normally needs a scan.
- Why maintain tail? Append and concatenate need no traversal.
- Why is delete by ID O(n)? Finding the node takes time, even though unlinking is O(1).
- What changes during reverse? Every node exchanges next/prev, then head/tail exchange. Current remains the same node.
- What prevents dangling pointers? Update current and neighbours before freeing; clear source pointers after transferring ownership.
- Why does JavaScript contain arrays/maps? They project C snapshots and recorded field writes for display; they do not implement playlist search, reverse, insertion, or deletion algorithms.
- Are intermediate frames valid lists? Not always: during reverse/merge/unlink, pointer assignments happen separately. C's final state must satisfy the invariants.
- Are comparisons invented? No: `playlist_find` records each visited node immediately before its actual ID comparison.
- What does Reset replay? Reset is an explicit committed replacement with an empty trace; it does not fabricate instructions for old nodes.
- Why does merge's HTTP request still scale with n? C must serialize the complete state and the browser must render it.

## Local review workflow

The project uses **OpenCodeReview (OCR)** locally, not CodeRabbit. If no OCR LLM endpoint is configured, its supported delegation mode exports the review scope and rules for an independent reviewer:

```sh
ocr delegate preview --from main --to HEAD --background-file PLAN.md --format json
ocr delegate rule --from main --to HEAD --background-file PLAN.md --format json src/playlist.c src/api.c src/server.c web/app.js
```

Review findings are validated, fixed, and checked again before merge. This is explicitly OCR delegation, not a claim that OCR's direct LLM review ran successfully.
