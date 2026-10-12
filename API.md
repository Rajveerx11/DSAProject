# Shared API contract

The local server listens on `127.0.0.1:8080` by default; run `./build/musiclab --port 8080` from the repository root. It serves `web/index.html`, `web/styles.css`, and `web/app.js`. No Python or runtime npm packages.

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
  "operation":{"action":"add","message":"Appended a node to the tail.","complexity":"O(1)","steps":["oldTail.next = newNode","newNode.prev = oldTail","tail = newNode"],"changed":[1,2]}
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

Initial demo state: main has 3 songs, secondary has 2. Titles/artists are invented demo content, not claims of licensed music. Frontend provides clearly labelled generated demo tones and optionally browser-local audio files attached to song IDs; C handles node metadata and playlist order, not audio decoding or file uploads. Browser-local audio is lost on reload; server state is lost on restart.

Errors: appropriate HTTP 400/404/405/413/415 status, `{"ok":false,"error":"Human-readable reason"}`, no partial mutation. Reject invalid IDs, unsupported actions/playlist IDs, oversized bodies, duplicate fields, invalid percent escapes, decoded NUL/control characters, and extra action fields where practical. Static file serving uses a strict allowlist; bind loopback only. Require expected local Host and reject foreign Origin on POST; no permissive CORS. Serve CSP allowing only own scripts/styles plus blob media, no inline script/event handlers.

UI contract: use returned server state, not JS arrays for playlist operations. Serialize requests/disable mutation controls while pending. Safe text rendering (`textContent`), accessible live operation feedback, reduced-motion equivalent, readable mobile list/visualizer. Controls: add, delete, select, next/previous, reverse, merge, reset, view toggle. Playback follows main's current node and stays consistent after deletion/selection/reversal.
