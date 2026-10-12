# Musiclab — records & pointers

A local music playlist manager and live **doubly linked list lab** for a second-year DSA demonstration. C owns the nodes and pointer operations. HTML, CSS, and JavaScript display C's returned state and handle browser audio.

## Run

Supported: Linux or Windows through WSL. You need a C11 compiler and Make; Node.js 18+ is needed for validation, not for running the app. No Python, framework, database, or runtime npm packages.

```sh
make
./build/musiclab
```

Open **http://127.0.0.1:8080** in your browser. Run from the repository root so the server can find `web/`. Stop with Ctrl+C. If that port is occupied:

```sh
./build/musiclab --port 8081
```

The server binds only to loopback. This is a single-process, serial classroom application, **not a production web server** or an authenticated multi-user service. Do not expose it to the internet.

## Using the player

- The demo starts with three tracks in **My playlist** and two in **Side B**.
- Select a main-playlist track, press Play, and try Next/Previous. Navigation stops at the ends; it does not wrap.
- Add a title and artist to either playlist. An optional local audio file stays in the browser; only metadata goes to C. Supported audio formats depend on your browser.
- Without a file, playback uses explicitly labelled, locally generated 12-second **demo tones**, not recordings of the named songs.
- Delete songs, reverse either playlist, merge Side B into My playlist, or reset the demo.
- Open **Show pointer lab** to inspect both lists, NULL links, head/tail/current IDs, changed nodes, and the backend's explanation.

The UI updates after each completed C operation. It does not pretend to be a debugger stepping through live machine instructions. Nodes use logical identifiers, not memory addresses. Another browser tab's changes appear after **Refresh state**, not via push synchronization.

### Defined behaviour

- First insertion sets head, tail, and current to the new node.
- Deleting current chooses its next node, otherwise its previous node, otherwise NULL.
- Reverse keeps the same current song while exchanging each node's links and the list endpoints.
- Merge transfers existing nodes without copying them and empties the source. The destination keeps current unless it was empty; then it inherits the source's current.
- IDs are process-wide and never reused during that server process, including after reset.
- There are at most 200 songs across both playlists. Title and artist must be non-empty valid UTF-8, at most 127 bytes each, with no control characters. The backend trims ASCII spaces.

State lives in RAM and disappears when the server stops. Browser-local audio associations disappear on reload; the UI honestly falls back to demo tones. No song files are uploaded or stored by C.

## Where the DSA lives

| Path | Responsibility |
|---|---|
| `src/playlist.h`, `src/playlist.c` | Node structs, manual pointer operations, allocation and freeing |
| `src/api.h`, `src/api.c` | Validate commands; traverse real nodes to serialize state; record explanations |
| `src/server.c` | Loopback HTTP adapter and allowlisted static files |
| `web/index.html`, `web/styles.css` | Accessible responsive player and pointer-lab layout |
| `web/app.js` | Requests, safe rendering, operation highlighting, browser audio |
| `tests/native.c`, `tests/api.mjs`, `web/check.cjs` | Pointer, API, security-input, and frontend checks |
| `API.md`, `PLAN.md` | Shared contract and delivery plan |

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

Stored nodes use **O(n)** space; pointer operations use **O(1)** auxiliary space. Every API response serializes both playlists, so the full request/response still takes **O(n)** time, even when the underlying mutation is O(1). Browser rendering and highlighting are also linear in displayed nodes.

### Pointer invariants

For every nonempty list: `head->prev == NULL`, `tail->next == NULL`, neighbouring links agree in both directions, size equals node count, and current belongs to that list. For an empty list, head/tail/current are all NULL and size is zero. Tests assert these after operations, including merges and deletion of current.

## Validate

```sh
make check       # warning-clean C build, native/API tests, JS syntax and frontend unit checks
make sanitize    # native + API tests with AddressSanitizer, UBSan, and leak detection
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

If Chromium needs system libraries, use Playwright's `install --with-deps chromium` command. Alternatively set `CHROMIUM_PATH` to an existing Chromium executable. The test owns an ephemeral C server and closes it on completion. It covers actual demo/local WAV playback, mutations, pointer rendering, responsive widths, keyboard focus, reduced motion, and page errors. Screenshots default to `/tmp/musiclab-browser-evidence`; override `MUSICLAB_EVIDENCE` if needed. CI runs these checks and uploads screenshots. This vanilla JavaScript project has no TypeScript typecheck or bundler build step.

## Ten-minute demonstration

1. **0–1 minute — Problem:** Explain why a playlist needs forward/back navigation and why a doubly linked list fits.
2. **1–3 — Navigate:** Play demo audio, move Next/Previous, open the pointer lab, identify head/tail/current and NULL boundaries.
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
- Why does JavaScript contain arrays? They are read-only snapshots for display, not the implementation of the playlist.
- Why does merge's HTTP request still scale with n? C must serialize the complete state and the browser must render it.

## Local review workflow

The project uses **OpenCodeReview (OCR)** locally, not CodeRabbit. If no OCR LLM endpoint is configured, its supported delegation mode exports the review scope and rules for an independent reviewer:

```sh
ocr delegate preview --from main --to HEAD --background-file PLAN.md --format json
ocr delegate rule --from main --to HEAD --background-file PLAN.md --format json src/playlist.c src/api.c src/server.c web/app.js
```

Review findings are validated, fixed, and checked again before merge. This is explicitly OCR delegation, not a claim that OCR's direct LLM review ran successfully.
