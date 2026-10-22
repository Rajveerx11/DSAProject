# Project Scope and Design Goals

[Back to README](README.md)

This document summarizes the submission scope. Implementation details are in the [architecture guide](docs/ARCHITECTURE.md), [API reference](API.md), and [simulation reference](SIMULATION.md).

## Problem statement

A playlist needs ordered storage, efficient forward/backward navigation, and predictable behavior when records are inserted, deleted, reordered, or combined. Musiclab uses this problem to demonstrate a manually implemented doubly linked list and make its pointer operations visible.

## Objectives and implementation

| Objective | Implementation | Relevant validation |
| --- | --- | --- |
| Manual linked-list operations | `src/playlist.c` | `tests/native.c` |
| Clear memory ownership | Per-node allocation, unlink/free, transfer on merge, cleanup | Native tests and sanitizers |
| Accurate educational replay | Synchronous observers, copied snapshots, ordered events | `tests/trace.c`, `web/check.cjs` |
| Separate transport and algorithms | `server.c` → `api.c` → `playlist.c` | `tests/api.mjs` |
| Usable demonstration | Two views, guided controller, optional local audio | Frontend unit and browser tests |
| Bounded input and output | UTF-8 policy, song/body/trace/response limits | Native, capacity, HTTP negative tests |

## Implemented scope

- Two in-memory playlists with append, select/search by ID, next/previous, delete, reverse, merge, display, reset, and cleanup.
- A local C HTTP server serving browser assets and two API endpoints.
- Demo with explicit sample/local audio playback and a silent Simulation view.
- Recorded allocation, visit, pointer-write, and free events; manual and automatic replay.
- An eight-action guided tour with pause/resume, stop, speed, and cancellation handling.
- Responsive layouts, reduced-motion behavior, input feedback, and automated validation targets.

Tests express expected behavior; their presence is not proof of a passing run. Follow the [testing guide](docs/TESTING.md) to validate a submission checkout.

## Scope boundaries

The project prioritizes syllabus algorithms and explainable behavior over production infrastructure. It excludes a database, authentication, public hosting, concurrent user sessions, streaming services, and audio uploads. IDs identify nodes within one process; they are not persistent database keys.

## Possible future work

These are proposals, not implemented features:

- Save/load playlists with a validated persistence format.
- Search by title/artist and explain its traversal cost.
- Add sorting with a documented algorithm and trace model.
- Export traces for offline study.
- Design separate concurrent sessions if the application grows beyond classroom use.

Extensions should preserve pointer invariants, define ownership and failure behavior, and add validation before being described as complete.
