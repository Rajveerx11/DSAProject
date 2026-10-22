# Testing and Validation

[Back to README](../README.md) · [Development guide](../CONTRIBUTING.md)

Run all commands from the repository root on Linux/WSL. Standard checks need a C11 compiler, GNU Make, and Node.js 18+; CI uses Node.js 22. Browser tests additionally need Playwright 1.56.1 and Chromium.

## Standard checks

```sh
make check
make sanitize
```

`make check` builds C with `-std=c11 -Wall -Wextra -Wpedantic -Werror`, runs native/trace/API tests, checks JavaScript syntax, and executes frontend unit/contract checks. `make sanitize` builds separate binaries with AddressSanitizer and UndefinedBehaviorSanitizer, enables leak detection, and runs native/trace/API tests again.

There is no TypeScript typecheck or bundler step. The application does not need a runtime npm install.

## Targets and coverage

| Command | What it checks |
| --- | --- |
| `make` | Builds `build/musiclab` |
| `make test` | Native invariants, trace suite, HTTP/API integration |
| `make test-trace` | Trace order, visits, parity, snapshot lifetime, capacity |
| `make test-api` | Normal and negative HTTP/API behavior |
| `node --check web/app.js` | JavaScript syntax only |
| `node web/check.cjs` | Text policy, trace projection, controller/audio units, DOM contracts |
| `make check` | Combined standard checks, including browser-script syntax |
| `make sanitize` | Native/trace/API memory, undefined behavior, and leak checks |
| `make test-browser` | Optional real Chromium flows against an owned C server |
| `make clean` | Removes generated `build/` outputs |

Native tests cover deletion cases, navigation boundaries, reverse, merge, UTF-8/bounds, cleanup, invariants, and observers. Trace tests also check allocation-failure preservation and worst-case escaped response capacity.

API tests create their own ephemeral server, temporary asset fixtures, and ports. They cover actions, malformed fields, IDs, byte limits, UTF-8, framing, Host/Origin restrictions, static-path allowlisting, deadlines, disconnects, and reset-response guards. They do not modify repository UI files or the manually running demo server.

Frontend unit tests use fixtures and media doubles. Passing them does not establish real browser decoding, geometry, keyboard behavior, or full tour completion.

## Optional real-browser suite

Install tooling outside the checkout to avoid introducing project package files:

```sh
npm install --prefix /tmp/musiclab-browser-tools --no-audit --no-fund playwright@1.56.1
node /tmp/musiclab-browser-tools/node_modules/playwright/cli.js install chromium
NODE_PATH=/tmp/musiclab-browser-tools/node_modules make test-browser
```

If Linux system libraries are missing, use Playwright's supported dependency installation (it may require administrator privileges):

```sh
node /tmp/musiclab-browser-tools/node_modules/playwright/cli.js install --with-deps chromium
```

An existing system Chromium can be selected explicitly:

```sh
NODE_PATH=/tmp/musiclab-browser-tools/node_modules \
CHROMIUM_PATH=/usr/bin/chromium make test-browser
```

Prefer the matching Playwright-managed browser when investigating version-dependent differences. Browser downloads require access to Playwright's download hosts, including `cdn.playwright.dev` and `playwright.download.prss.microsoft.com`.

`tests/browser-run.cjs` starts an ephemeral C server from the repository root, runs `tests/browser.cjs`, and stops its server on completion. Do not start a separate server for this target.

The suite includes assertions for:

- Native sample/local audio decoding, nonzero samples, playback lifecycle, file association, and cleanup.
- Actual recorded frames, arrows, visits, allocation/free ghosts, and manual replay.
- Routing/state preservation, eight ordered guided POSTs, pause/resume/stop/speed, duplicate starts, in-flight acceptance, and failure handling.
- Keyboard focus, reduced motion, desktop/tablet/mobile layouts, active-card/control visibility, and full small-screen tours.

Screenshots default to `/tmp/musiclab-simulator-evidence`; set `MUSICLAB_EVIDENCE` to choose another directory outside the checkout. If an assertion fails, later assertions have not been validated.

## Continuous integration

[`.github/workflows/validate.yml`](../.github/workflows/validate.yml) runs on pushes to `main` and pull requests. It uses Ubuntu and Node.js 22, runs `make check` and `make sanitize`, installs isolated Playwright 1.56.1 with Chromium dependencies, runs the browser target, and uploads available screenshots as `musiclab-browser-evidence`.

Describe results from the actual run being submitted. A workflow definition, cached output, syntax-only success, or partial suite is not evidence that all behavior passed.

## Diagnosing failures

| Failure | Next step |
| --- | --- |
| `node` missing/too old | Install a supported version; use Node.js 22 to match CI |
| `Cannot find module 'playwright'` | Check the external install prefix and `NODE_PATH` |
| Missing Chromium executable | Install Playwright Chromium or set `CHROMIUM_PATH` |
| Browser download denied | Permit the required download hosts in network settings; retain TLS verification |
| Missing browser shared libraries | Use Playwright's supported `--with-deps` installation |
| Sanitizer runtime unavailable | Check compiler/runtime support; record the check as unrun rather than disabling instrumentation |
| Assertion failure | Record the assertion, command, browser/tool versions, and exit status; distinguish app behavior from missing prerequisites |

For a report, record the tested commit and commands, which suites completed, and any failures or unrun checks. Reproduce failures before claiming a fix. Avoid piping test output in a way that hides the underlying exit status.
