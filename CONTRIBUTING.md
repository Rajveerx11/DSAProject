# Development Guide

[Back to README](README.md)

## Local workflow

1. Build and run from the repository root using the [README](README.md#build-and-run).
2. Make a focused change in the module that owns the behavior.
3. Run relevant checks from [docs/TESTING.md](docs/TESTING.md). Run `make check` before submitting; use sanitizers for C/memory changes and browser checks for UI behavior.
4. Update documentation when behavior, commands, limits, or contracts change.
5. Review `git diff` and `git status --short`. Keep generated binaries, browser dependencies, screenshots, local audio, and machine-specific files out of commits.

## Code boundaries

- Keep linked-list algorithms in `src/playlist.c`; transport and UI should call or project them.
- Preserve endpoint/current, reciprocal-link, size, and ownership invariants after each complete operation.
- Tie events to actual C operations. Do not invent browser events to make an animation look correct.
- Keep IDs logical and process-scoped. Never serialize raw addresses.
- Preserve bounded UTF-8 validation and safe JSON/DOM rendering. Display metadata as text.
- Keep audio in the browser and document any new runtime dependencies.

## Useful entry points

| Change | Start here |
| --- | --- |
| List behavior / ownership | `src/playlist.h`, `src/playlist.c`, `tests/native.c` |
| Action validation / trace payload | `src/api.c`, `tests/trace.c`, `tests/api.mjs` |
| HTTP parsing / static routes | `src/server.c`, `tests/api.mjs` |
| Replay / tour / audio | `web/app.js`, `web/check.cjs`, `tests/browser.cjs` |
| Layout / accessibility | `web/index.html`, `web/styles.css`, browser checks |

## Reporting a problem

Include OS/WSL version, compiler and Node versions, the exact command or UI steps, expected and actual behavior, and error output. For browser issues, include browser/version, viewport, selected view, and reduced-motion setting. For test failures, include the assertion and exit status rather than only a screenshot.
