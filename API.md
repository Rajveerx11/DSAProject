# Shared API contract

The local server listens on `127.0.0.1:8080` by default; run `./build/musiclab --port 8080` from the repository root. It serves `web/index.html`, `web/styles.css`, `web/app.js`, and `web/favicon.svg`. No Python or runtime npm packages.

## State
`GET /api/state` returns JSON. All successful mutations return the same shape with a fresh operation:

```json
{
  "ok": true,
  "playlists": [
    {"id":"main","name":"My playlist","head":1,"tail":2,"current":1,"size":2,
     "nodes":[
       {"id":1,"title":"Paper Moon","artist":"Demo tones","prev":null,"next":2},
       {"id":2,"title":"Slow Orbit","artist":"Demo tones","prev":1,"next":null}
     ]},
    {"id":"secondary","name":"Side B","head":null,"tail":null,"current":null,"size":0,"nodes":[]}
  ],
  "operation":{
    "action":"add","message":"Appended a node to the tail.","complexity":"O(1)",
    "steps":["newNode.prev = oldTail","oldTail.next = newNode","tail = newNode"],"changed":[1,2],
    "trace":{
      "before":[
        {"id":"main","name":"My playlist","head":1,"tail":1,"current":1,"size":1,
         "nodes":[{"id":1,"title":"Paper Moon","artist":"Demo tones","prev":null,"next":null}]},
        {"id":"secondary","name":"Side B","head":null,"tail":null,"current":null,"size":0,"nodes":[]}
      ],
      "events":[
        {"kind":"allocate","playlist":"main","id":2,"title":"Slow Orbit","artist":"Demo tones","prev":null,"next":null},
        {"kind":"pointer","playlist":"main","id":2,"field":"prev","from":null,"to":1},
        {"kind":"pointer","playlist":"main","id":1,"field":"next","from":null,"to":2},
        {"kind":"pointer","playlist":"main","id":null,"field":"tail","from":1,"to":2}
      ],
      "truncated":false
    }
  }
}
```

IDs are positive integers, unique across the two lists for this process; they are logical identifiers, not addresses. `nodes` is serialized by forward traversal of the actual C linked list. `head`, `tail`, `current`, `prev`, and `next` use JSON null for NULL pointers. `steps` is a short textual explanation recorded by the backend, not a claim of live instruction-level debugging. `changed` is advisory highlighting, not a separate source of state.

## Actions
`POST /api/action`, header `Content-Type: application/x-www-form-urlencoded`, body encoded with browser `URLSearchParams`.

- `action=add&playlist=main&title=...&artist=...`: append, O(1) with tail. Trim/validate non-empty fields, max 127 UTF-8 bytes each. Client uses matching validation. Maximum 200 nodes total.
- `action=delete&playlist=main&id=1`: search by ID and delete, O(n). If deleting current choose next, otherwise previous, otherwise NULL.
- `action=select&playlist=main&id=1`: search by ID and set current, O(n).
- `action=next&playlist=main` / `action=previous&playlist=main`: O(1); stop at boundaries with explanatory successful no-op. No circular wrapping.
- `action=reverse&playlist=main`: swap prev/next on every node, then head/tail; current remains the same song, O(n).
- `action=merge&playlist=main&source=secondary`: splice source onto destination in O(1), empty source, keep destination current unless destination was empty. Reject self-merge.
- `action=reset`: restore small clearly labelled demo playlists. Generate fresh IDs rather than reusing removed IDs.

Initial demo state: main has 3 records, secondary has 2. Titles/artists are sample metadata only; this is a silent simulation with no audio or files. C handles node metadata and playlist order. Server state is lost on restart.

Errors: appropriate HTTP 400/404/405/413/415 status, `{"ok":false,"error":"Human-readable reason"}`, no partial mutation. Reject invalid IDs, unsupported actions/playlist IDs, oversized bodies, duplicate fields, invalid percent escapes, decoded NUL/control characters, and extra action fields where practical. Static file serving uses a strict allowlist; bind loopback only. Require expected local Host and reject foreign Origin on POST; no permissive CORS. Serve CSP allowing only own scripts/styles plus blob media, no inline script/event handlers.

UI contract: default `/#demo` shows manual playlist controls without visualization; `/#simulation` shows left operation desk/right recorded pointer canvas and an explicit Start tour. Hash routes need no server changes and navigation preserves C state. Guided Start visibly warns that it resets both playlists, then submits reset/add/next/previous/select-added/delete-added/reverse/merge sequentially through this same API. It derives IDs from C, awaits each response and replay, and supports pause/resume/stop/speed; stop or view exit cancels future work, not already sent C mutations. See `GUIDED_DEMO.md`. C code and API are unchanged. Use returned server state and recorded events, not independent JS playlist algorithms. Serialize requests/disable mutation buttons while pending. Safe text rendering (`textContent`), keyboard focus preservation, reduced-motion equivalent, and a stacked mobile layout. Controls: add, delete, select, next/previous, reverse, merge, reset; plus replay auto-play, pause/continue, previous/next step, replay, finish, and speed. A new action finishes old historical playback before requesting C; replay never resubmits the action.

## Recorded operation trace
Every successful state includes `operation.trace` with `before` (two copied C playlist snapshots), `events`, and `truncated`. See `SIMULATION.md` for event shapes. `allocate`, `visit`, `pointer`, and `free` events are emitted by actual DLL code. Numeric node IDs represent node pointer fields; `id:null` represents playlist head/tail/current fields. From/to use null for NULL. Initial/reset traces are empty explicit replacements with before equal to final state. Invalid requests preserve the previous trace. Capacity is 632 events and a 512 KiB response budget; allowed operations at 200 records are fully captured. Intermediate frames are historical allocation/field projections and may be cyclic or temporarily disconnected; final order/membership/size comes exclusively from top-level playlists.
