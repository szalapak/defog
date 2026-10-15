# Benchmark harness

Measures suggestion quality against real Fog of World data, headless under Node.
Needs a `Sync/` folder in the repo root (gitignored: it is personal location
history, never commit it).

```
node bench/characterize.js          # defog density maps; pick scenario centres
node bench/run.js [out] [filter]    # run the app's SuggestTool on bench/scenarios.js
node bench/overpass.js [filter]     # street-network context (total vs undefogged km)
```

- `lib/load.js` loads the real `app/src` parser + suggest code over a Leaflet stub,
  so benchmarks exercise the exact shipping algorithm.
- `lib/gain.js` replicates `computeGain`/`cellIsNew` from `main.js` (kept in sync by hand).
- All BRouter/Overpass responses are disk-cached in `bench/cache/` (gitignored):
  re-runs are free, reproducible, and kind to the public servers. Delete the cache
  to re-measure live. Avoid live runs while also testing in the browser: brouter.de
  throttles per IP.
- Results land in `bench/out/<name>.json` (gitignored) with per-card metrics:
  defogged area, m² per metre, % new ground, overlap %, elongation
  (1 = round blob, 3+ = a proper thin "line" of a loop).

## A to B wanted distance

`node bench/p2p-window.test.js` checks the window maths with no network or fog.
`node bench/p2p-target.js [profile]` runs the six routing profiles through the real
`SuggestTool` against your fog (`P2P_PINS="lat,lng;lat,lng"` picks the pins, default
is the Dresden `neustadt-p2p` pair). One live run per profile is enough: responses are
cached. brouter.de answers 403 "Please, retry later" when throttled; a rerun after a
few minutes refetches only what failed.

Observed on a real fog, ~4 km pins, 15% buffer unless noted:
- trekking, fastbike, hiking-mountain, car-fast, rail, shortest: all cases stay inside
  the promised window.
- A 5% window at 1.5x the fastest route often finds nothing (trekking, car-fast, rail,
  shortest) and shows the fastest route as a flagged fallback.
- 10x the fastest route is reachable on trekking and fastbike, but falls back on
  hiking-mountain, car-fast, rail and shortest.
  (These three bullets describe the tree before the retrace work; after it, car-fast and
  shortest return real cards at 10x and rail and car-fast at a 5% window, see below.)
- Retracing (`node bench/p2p-target.js` prints `retr max`, the best card's m2/km and the
  fetch count per case, BRouter and Overpass, cache hits included). Before/after the
  retrace work, same pins, 15% buffer, cache warm; only trekking and fastbike completed
  (the other four were throttled, see the warm rerun below), and reruns differ by a few
  percent:
  - trekking, 1.5x: max retrace 15% -> 9%, best area per km 21268 -> 21533; 5% window
    unchanged (25%, 22288); 10x: 77% both, area per km 23737 -> 25664.
  - fastbike, 1.5x: max retrace 31% -> 10%, best area per km 19863 -> 20563; 5% window
    19918 -> 22117 (max retrace 11% -> 23%, a better card, not a worse route).
  - fetches per run: +0 to +2 (the re-route cap is 2).
  A card that retraces on purpose (a real dead end) is only discounted, never dropped.
  - "Use" hand-off in the browser (trekking, pins as above, 1.5x = 5.1 km, 15%; editor
    length and retrace read from the route editor's polyline). Cards are not deterministic
    between reruns, so each row is from the set live when Use was pressed:

    | run   | card | card km | card retrace | editor km | editor retrace | re-routed | verdict |
    |-------|------|---------|--------------|-----------|----------------|-----------|---------|
    | blank | 0    | 3.9     | 0 (4% real)  | 3.93      | 4.0%           | n         | pass    |
    | 5.1   | 0    | 5.1     | 0            | 5.07      | 0%             | n         | pass    |
    | 5.1   | 1    | 5.1     | 0            | 4.99      | 1.8%           | y, 80 m   | pass*   |
    | 5.1   | 2    | 4.6     | 0 (7.1% real)| 4.55      | 7.1%           | n         | pass    |
    | ~14   | 0    | 16.3    | 0            | 16.26     | 0%             | n         | pass    |
    | ~14   | 1    | 13.8    | 0            | 13.74     | 0%             | n         | pass    |
    | ~14   | 2    | 14.7    | 10%          | 14.72     | 10.2%          | n         | pass    |

    *km -2.2% and retrace +1.8 points, inside the 3% / +5 point criteria, but BRouter
    chose another street for part of the path (editor up to 80 m off the preview).
    Card retrace labels matched the editor's. No >=50% or bridge-only card appeared.
  - `overlapFrac(coords, false)` on a 16.3 km card (729 points): 0.7-0.9 ms per call.
  - Loops unchanged: `node bench/run.js` on the six loop scenarios, `ab-target-distance`
    (with the same `overlapFrac` patch) against this branch: card count, km and defogged
    area identical in every scenario. The neustadt-p2p scenario differs as intended (third
    card 4.08 km with 9% overlap -> 3.73 km with 0%).
  - The four profiles that were throttled earlier, before -> after, both trees run back to
    back on one warm cache, one profile per invocation. A first pass run while brouter.de
    was throttling silently lost candidate requests (no `SKIP`, just fewer or worse
    cards) and produced fake deltas, so only this rerun is recorded. Cards, `retr max`,
    best m2/km (fetch counts from `p2p-target.js` include cache hits and do not show misses):

    | profile / case          | cards      | retr max   | best m2/km       | fallback    |
    |-------------------------|------------|------------|------------------|-------------|
    | hiking-mountain untarg. | 3 -> 3     | 0 -> 0%    | 25625 = 25625    | no          |
    | hiking-mountain 1.5x    | 3 -> 3     | 13 -> 7%   | 22471 = 22471    | no          |
    | hiking-mountain 1.5x 5% | 3 -> 3     | 3 -> 3%    | 22637 = 22637    | no          |
    | hiking-mountain 0.5x    | 3 -> 3     | 0 -> 0%    | 25625 = 25625    | no          |
    | hiking-mountain 10x     | 3 -> 3     | 56 -> 56%  | 24134 -> 29434   | no          |
    | car-fast untargeted     | 2 -> 2     | 0 -> 0%    | 17619 = 17619    | no          |
    | car-fast 1.5x           | 3 -> 3     | 37 -> 10%  | 18414 -> 19828   | no          |
    | car-fast 1.5x 5%        | 3 -> 3     | 33 -> 9%   | 18405 -> 19636   | no          |
    | car-fast 0.5x           | 2 -> 2     | 0 -> 0%    | 17337 = 17337    | no          |
    | car-fast 10x            | 3 -> 3     | 31 -> 18%  | 25569 = 25569    | no          |
    | rail untargeted         | 1 -> 1     | 6 -> 0%    | 18032 -> 19679   | no          |
    | rail 1.5x               | 1 -> 1     | 11 -> 11%  | 17681 = 17681    | no          |
    | rail 1.5x 5%            | 1 -> 2     | 0 -> 0%    | 18723 -> 19290   | yes -> no   |
    | rail 0.5x               | 1 -> 1     | 6 -> 0%    | 18032 -> 19679   | no          |
    | rail 10x                | 1 -> 1     | 0 -> 0%    | 18723 = 18723    | yes, yes    |
    | shortest untargeted     | 3 -> 3     | 0 -> 0%    | 25075 = 25075    | no          |
    | shortest 1.5x           | 3 -> 3     | 30 -> 4%   | 19553 -> 22390   | no          |
    | shortest 1.5x 5%        | 2 -> **1**  | 22 -> 9%   | 21726 -> 21511   | no          |
    | shortest 0.5x           | 3 -> 3     | 0 -> 0%    | 22655 = 22655    | no          |
    | shortest 10x            | 3 -> 3     | 45 -> 27%  | 30949 = 30949    | no          |

    One case is flagged by the rules (fewer cards): shortest 1.5x 5%. The dropped card
    (4.95 km, a 22% retracer) is the one the penalty discounts. `RETRACE_WEIGHT` 0.3, 0.5
    and 0.7 all leave one card (5.06, 5.06, 4.94 km; the 0.7 card retraces 7%), so no
    weight restores it: it is the planner/ranking order, not the weight. The surviving
    card is in the window and 1% below in m2/km, so it is recorded and left. Earlier
    first-pass flags (hiking-mountain 0.5x, shortest untargeted) vanished in the warm rerun.
    That card count is the one open item; `RETRACE_WEIGHT` stays 0.5.

  Decision: no code change. Task 1 passed numerically (the one visibly re-routed card,
  5.1 km card 1, is -2.2% in km and +1.8 points of retrace at one-decimal card precision),
  `overlapFrac` takes under 1 ms on a 16 km route, loops are identical, and the only
  flagged case is not moved by the weight. Cards retracing >= 50% (hiking-mountain 10x
  56%, trekking 10x 77%) are still returned and labelled by `main.js` for retrace >= 10%;
  the browser check showed one labelled card (10% at ~14 km, matching the editor's 10.2%)
  and no >= 50% card, so that label is verified only for that one case.
- car-fast and rail search the "bike" street set (`streetKind`), so their candidates
  are not guided by car or rail networks.
