# Route Guardian (CCNY Edition)

A commute dashboard for CCNY students that tracks nearby subway lines (1,
A, C, D) and bus routes, showing live crowding/delay estimates and
suggesting micro-breaks when your commute stress is high.

This project was rebuilt from the original static mockup (`original.txt`)
into a small full-stack app so it can talk to **real-time MTA data**
instead of simulated numbers.

## How it works

- **Backend (`server/`)**: A small Express server fetches the MTA's free,
  keyless GTFS-Realtime protobuf feeds for the subway divisions serving
  CCNY-area stations (137th St-City College on the 1, and 145th/125th St
  on the A/C/D), decodes them with `gtfs-realtime-bindings`, and exposes a
  simple JSON summary at `GET /api/status` (arrivals, delay-derived
  status, and a crowding estimate). Responses are cached for ~25s to stay
  within a good refresh cadence without hammering the upstream feed.
- **Frontend (`public/`)**: Polls `/api/status` every 20 seconds and
  renders live status cards, an animated stress meter, and a map that
  reflects real conditions on your monitored routes.
- Bus routes (Bx15, M100) require a separate, keyed **MTA Bus Time API**
  subscription, so they currently show a clearly labeled estimate instead
  of live data - see `public/js/app.js` (`busFallbackStatus`) if you want
  to wire up a real Bus Time feed.

## Running locally

```bash
npm install
npm start
```

Then open http://localhost:3000. The server needs outbound internet
access to reach `api-endpoint.mta.info`; if that feed is unreachable
(e.g. in a sandboxed/offline environment), `/api/status` returns a
"Data Unavailable" status per route instead of crashing, and the UI
falls back to showing the last known values.

## Notes / follow-ups

- The GTFS `stop_id`s used for CCNY-area stations in `server/mta.js` are
  documented inline; double check them against the official MTA
  `stops.txt` if station numbering ever changes.
- GTFS-Realtime doesn't publish rider-counted crowding, so the "crowd %"
  is a heuristic derived from live schedule delay and how bunched
  upcoming trains are - it is a reasonable proxy, not exact occupancy.
