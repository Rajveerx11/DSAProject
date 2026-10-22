# HTTP API Reference

[Back to README](README.md) · [Architecture](docs/ARCHITECTURE.md) · [Trace format](SIMULATION.md)

The C server listens on `127.0.0.1:8080` by default. Examples below use `./build/musiclab --port 8081` from the repository root. Requests and responses use UTF-8. No authentication or persistent storage is provided.

## Routes

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/state` | Both committed playlists and the latest operation |
| POST | `/api/action` | Execute one action and return state plus its operation |
| GET | `/`, `/index.html` | Browser HTML shell |
| GET | `/styles.css`, `/app.js`, `/favicon.svg` | Allowlisted static assets |

Other static paths and unknown API endpoints return 404. Hash routes (`/#demo`, `/#simulation`) are browser-side; fragments are not sent to the server. Paths are matched exactly.

## Read state

```sh
curl --fail-with-body http://127.0.0.1:8081/api/state
```

A successful response contains:

| Field | Meaning |
| --- | --- |
| `ok` | `true` |
| `playlists` | Two playlist objects, identified by `main` and `secondary` |
| `operation.action` | Latest accepted action name |
| `operation.message` | Human-readable outcome, including boundary/no-op behavior |
| `operation.complexity` | Underlying list-operation complexity |
| `operation.steps` | Short educational explanation strings |
| `operation.changed` | Advisory node IDs for highlighting; not authoritative state |
| `operation.trace` | Owned `before` playlists, ordered `events`, and `truncated` flag |

Each playlist has `id`, `name`, `head`, `tail`, `current`, `size`, and `nodes`. The following is an illustrative playlist object, not the complete initial response:

```json
{
  "id": "main",
  "name": "My playlist",
  "head": 1,
  "tail": 2,
  "current": 1,
  "size": 2,
  "nodes": [
    {"id": 1, "title": "Track A", "artist": "Sample", "prev": null, "next": 2},
    {"id": 2, "title": "Track B", "artist": "Sample", "prev": 1, "next": null}
  ]
}
```

`nodes` is serialized by forward traversal of actual C nodes. IDs are positive 32-bit integers unique within the process; pointers are IDs or JSON `null`. Empty lists have no nodes and null head/tail/current. Initial sample sizes are three and two.

GET does not perform a new operation or reset the app. It can return the previous operation's label and trace. Consumers should reconcile current IDs and membership rather than interpreting a historical action label as a new mutation.

## Execute an action

Send `Content-Type: application/x-www-form-urlencoded` (optionally `; charset=UTF-8`). JSON and multipart uploads are not accepted. Browser clients can encode fields with `URLSearchParams`.

| Action | Exact fields | Behavior |
| --- | --- | --- |
| `add` | `action`, `playlist`, `title`, `artist` | Append one node; select it if the list was empty |
| `select` | `action`, `playlist`, `id` | Traverse by ID and set current |
| `delete` | `action`, `playlist`, `id` | Traverse, unlink, and free; deleting current chooses next, else previous, else null |
| `next` / `previous` | `action`, `playlist` | Move one link; boundary/empty navigation succeeds without moving |
| `reverse` | `action`, `playlist` | Reverse links/endpoints while retaining current |
| `merge` | `action`, `playlist`, `source` | Transfer source nodes into destination `playlist`; empty source; reject self-merge |
| `reset` | `action` | Replace both lists with sample data and fresh process-wide IDs |

`playlist` and `source` must be `main` or `secondary`. IDs must be decimal integers from 1 through 4294967295 and identify a node in the specified playlist. Extra or duplicate fields are rejected. The UI offers merge B into A; the API accepts either distinct source/destination pair.

### Examples

Append metadata, safely encoding spaces and special characters:

```sh
curl --fail-with-body http://127.0.0.1:8081/api/action \
  --data-urlencode 'action=add' \
  --data-urlencode 'playlist=main' \
  --data-urlencode 'title=Evening Walk' \
  --data-urlencode 'artist=Student Demo'
```

Reverse Side A:

```sh
curl --fail-with-body http://127.0.0.1:8081/api/action \
  --data 'action=reverse&playlist=main'
```

Merge Side B into Side A:

```sh
curl --fail-with-body http://127.0.0.1:8081/api/action \
  --data 'action=merge&playlist=main&source=secondary'
```

Use IDs returned by GET/add when selecting or deleting; do not assume a fixed ID after reset. The examples above mutate state, so run them on a demonstration session where those changes are acceptable. All successful actions return the same full response shape as GET, with a new operation.

## Validation and limits

| Limit | Value / policy |
| --- | --- |
| Songs | 200 total across both playlists |
| Title / artist | Each 1–127 UTF-8 bytes after trimming ASCII spaces at both edges |
| Text | Valid UTF-8; reject U+0000–U+001F and U+007F–U+009F controls; no silent truncation |
| Request body | 4096 bytes maximum |
| Header input buffer | 8192 bytes; up to 64 headers |
| Request read deadline | 2000 ms for headers and body combined |
| Static file | 1 MiB maximum per allowlisted asset |
| Trace | 632 events (`3 * SONG_LIMIT + 32`); overflow sets `truncated` |
| JSON response buffer | 512 KiB, including space needed for string termination |

The buffer limits are implementation bounds, not a general-purpose HTTP compatibility promise. The parser requires HTTP/1.1 and a valid local Host. POST requires Content-Length. Transfer-Encoding, Expect, duplicate headers, malformed escapes, decoded NUL, and surplus buffered body bytes are rejected.

## Errors

```json
{"ok": false, "error": "Song ID not in this playlist."}
```

| Status | Typical cause |
| --- | --- |
| 400 | Invalid form/fields/ID/text, song limit, self-merge, malformed request framing |
| 403 | Invalid Host, foreign mutation Origin, or rejected Sec-Fetch-Site |
| 404 | Node not in selected playlist, unknown API route, or unavailable/disallowed static path |
| 405 | Wrong method; `Allow` indicates the endpoint's method |
| 408 | Request read deadline exceeded |
| 413 | Body/header limits exceeded |
| 415 | Unsupported POST content type |
| 500 | Allocation failure, ID exhaustion, response capacity failure, or internal I/O failure |

Rejected action validation leaves the previous playlists and operation trace unchanged. If a connection fails after a POST was sent, the operation may already have committed. Refresh state before deciding whether to retry; do not automatically repeat a mutation after an uncertain response.

## Local-origin and media behavior

Host must match `localhost:<port>` or `127.0.0.1:<port>` (bare names are accepted at port 80). If supplied on POST, Origin must be `http://` plus that same Host; localhost and 127.0.0.1 are different origins. Non-browser clients may omit Origin. There is no permissive CORS response.

Responses close the connection, disable caching, and include CSP, nosniff, frame denial, and no-referrer headers. The CSP permits same-origin assets and browser blob media. Audio bytes are never part of API state or action fields: optional files remain in the browser, associated with returned C IDs.
