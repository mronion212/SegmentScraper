# Runtime audit benchmark

`runtime-audit.cjs` measures runtime work rather than bundle size. It loads the
source files in isolated VM contexts and reports deterministic operation counts
for the audited hot paths. Wall-clock timings are included as secondary context
only.

## Scenarios

- 500 `mousemove` events before the browser runs the next animation frame,
  followed by all pending frame/timer callbacks.
- Crunchyroll initial setup plus 100 polls on the same watch page with the same
  two JSON-LD script nodes.
- 60 Prime Video catalogue scans over the same 100 episode cards.
- A SkyShowtime catalogue fetch/resource-observer race, plus a direct response
  whose cloned JSON parse fails.

## Immutable before baseline

The before source is commit `3270ff7` (`Merge pull request #15 from
mronion212/feat/SharedConsoleLogs`). The operation counts below are deterministic;
they were captured with Node v23.6.0.

| Scenario | Metric | `3270ff7` before |
| --- | --- | ---: |
| 500 mousemoves, immediately after burst | `getElementById` | 1,000 |
|  | `querySelector` | 500 |
|  | `getComputedStyle` | 500 |
|  | style writes | 2,000 |
|  | `setTimeout` calls | 1,000 |
|  | `clearTimeout` calls | 500 |
|  | pending timers | 501 |
|  | pending animation frames | 0 |
| 500 mousemoves, after pending callbacks | `getElementById` | 1,501 |
|  | `querySelector` | 1,000 |
|  | `getComputedStyle` | 1,000 |
|  | style writes | 3,002 |
| Crunchyroll setup + 100 stable polls | `querySelectorAll` | 101 |
|  | JSON-LD text reads | 202 |
|  | `JSON.parse` calls | 202 |
|  | `handleDetectedShow` calls | 101 |
|  | `recordExtractedSegments` calls | 101 |
|  | `recordProviderEpisode` calls | 1 |
|  | skip-event requests | 1 |
| Prime 60 scans x 100 cards | document `querySelector` | 120 |
|  | document `querySelectorAll` | 60 |
|  | card `querySelector` | 24,000 |
|  | `handleDetectedShow` calls | 60 |
|  | `recordProviderEpisode` calls | 6,000 |
|  | returned card records / final catalogue size | 6,000 / 100 |
| Sky direct-fetch/resource race | original / fallback requests | 1 / 1 |
|  | response clones / JSON reads | 1 / 1 |
| Sky direct parse failure | original / fallback requests | 1 / 0 |
|  | response clones / JSON reads | 1 / 1 |

Nine-run median internal timings on the baseline machine were 1.486 ms for the
mousemove dispatch burst, 2.100 ms for the Crunchyroll poll loop, and 37.573 ms
for the Prime scans. These timings are hardware-sensitive; use the operation
counts for regression comparisons.

## Current candidate after

These are the latest deterministic counts from the optimized source. Prime's
unchanged DOM selector counts are included explicitly: the safe optimization
avoids repeated catalogue writes and quadratic refresh work, but does not claim
to eliminate the polling scan itself.

| Scenario | Metric | Before | Current after | Change |
| --- | --- | ---: | ---: | ---: |
| 500 mousemoves, immediately after burst | DOM/layout reads and style writes | 4,000 | 0 | -100% |
|  | timeout calls | 1,000 | 0 | -100% |
|  | pending callbacks | 501 timers | 1 animation frame | coalesced |
| 500 mousemoves, after pending callbacks | `getElementById` | 1,501 | 4 | -99.73% |
|  | `querySelector` | 1,000 | 2 | -99.80% |
|  | `getComputedStyle` | 1,000 | 2 | -99.80% |
|  | style writes | 3,002 | 6 | -99.80% |
|  | timeout calls | 1,000 | 2 | -99.80% |
| Crunchyroll setup + 100 stable polls | `querySelectorAll` | 101 | 1 | -99.01% |
|  | JSON-LD text reads | 202 | 2 | -99.01% |
|  | `JSON.parse` calls | 202 | 2 | -99.01% |
|  | `handleDetectedShow` calls | 101 | 1 | -99.01% |
|  | `recordExtractedSegments` calls | 101 | 1 | -99.01% |
| Prime 60 scans x 100 cards | document `querySelector` | 120 | 120 | unchanged |
|  | document `querySelectorAll` | 60 | 60 | unchanged |
|  | card `querySelector` | 24,000 | 24,000 | unchanged |
|  | `handleDetectedShow` calls | 60 | 60 | unchanged |
|  | `recordProviderEpisode` calls | 6,000 | 100 | -98.33% |
|  | returned card records / final catalogue size | 6,000 / 100 | 6,000 / 100 | unchanged |
| Sky direct-fetch/resource race | original / fallback requests | 1 / 1 | 1 / 0 | duplicate removed |
| Sky direct parse failure | original / fallback requests | 1 / 0 | 1 / 1 | fallback preserved |
| Apple standalone metadata | root enumerations | 2 | 1 | -50% |
| Apple 3-episode fallback catalogue | `playables` enumerations | 4 | 2 | -50% |
| Apple paginated catalogue | root enumerations | 2 | 1 | -50% |

Nine-run median internal timings after the changes were 0.192 ms for the
mousemove dispatch burst, 0.102 ms for the Crunchyroll poll loop, and 19.943 ms
for the Prime scans: reductions of 87.1%, 95.1%, and 46.9%, respectively. The
operation counts remain the primary evidence.

## Reproduce

Run against the current worktree:

```powershell
node benchmark/runtime-audit.cjs
```

Recreate and measure the immutable before source without changing the worktree:

```powershell
$auditSnapshotRoot = Join-Path $env:TEMP ("segmentscraper-runtime-audit-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path (Join-Path $auditSnapshotRoot "head") -Force | Out-Null
git archive --format=tar --output (Join-Path $auditSnapshotRoot "head.tar") 3270ff7
tar -xf (Join-Path $auditSnapshotRoot "head.tar") -C (Join-Path $auditSnapshotRoot "head")
node benchmark/runtime-audit.cjs (Join-Path $auditSnapshotRoot "head")
```

The benchmark does not make network requests and does not write production
files.
