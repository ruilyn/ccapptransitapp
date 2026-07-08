# Smart Route Guardian – CCNY Edition 🚇

Real-time MTA transit dashboard for CCNY commuters, showing live delays,
crowding estimates, and service alerts for the subway and bus lines that
serve the City College of New York campus.

---

## Features

| Feature | Detail |
|---|---|
| **Live subway data** | GTFS-Realtime feeds for 1, A, C, D trains (137th, 145th, 125th St stops) |
| **Live bus data** | MTA Bus Time SIRI for Bx15 and M100 (requires separate key) |
| **Auto-refresh** | Frontend polls `/api/status` every 30 s (configurable) |
| **Resilient caching** | In-memory cache survives temporary feed outages; stale data is flagged to users |
| **Retry / back-off** | Exponential back-off on feed errors (5 s → 15 s → 30 s) |
| **Loading UX** | Skeleton shimmer while data loads; stale/error banners when degraded |
| **Stress score** | Aggregated crowding score + Guardian recommendations |
| **Map node colors** | Station dots update to green / amber / red based on live delay data |

---

## Requirements

- **Node.js ≥ 16**
- A free **MTA API key** (subway feeds)
- _(Optional)_ A free **MTA Bus Time API key** (bus feeds)

### Getting API keys

1. **Subway key** – Register at <https://api.mta.info/#/signup>. You will
   receive a key that goes in `MTA_API_KEY`.
2. **Bus key** – Request via the same developer portal or
   <https://bustime.mta.info/wiki/Developers/Index>. Assign it to
   `MTA_BUS_API_KEY`. If omitted, bus routes show *"No Bus Data"*.

---

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment variables
cp .env.example .env
# Edit .env and set at minimum:  MTA_API_KEY=your_key_here

# 3. Run the server
npm start          # production
npm run dev        # auto-reloads on file changes (Node 18+ --watch)
```

Open your browser at <http://localhost:3000>.

---

## Environment variables

| Variable | Default | Required | Description |
|---|---|---|---|
| `MTA_API_KEY` | _(none)_ | **Yes** | MTA subway GTFS-RT API key |
| `MTA_BUS_API_KEY` | _(none)_ | No | MTA Bus Time API key |
| `PORT` | `3000` | No | HTTP server port |
| `POLL_INTERVAL_MS` | `30000` | No | How often (ms) to poll MTA feeds |
| `STALE_THRESHOLD_MS` | `90000` | No | Age (ms) after which cached data is marked stale |
| `FETCH_TIMEOUT_MS` | `10000` | No | Per-request HTTP timeout (ms) |
| `MAX_RETRIES` | `3` | No | Consecutive failures before entering error state |
| `MTA_FEED_123456` | _(MTA default)_ | No | GTFS-RT trip-updates feed for 1–7 trains |
| `MTA_FEED_ACE` | _(MTA default)_ | No | GTFS-RT feed for A/C/E trains |
| `MTA_FEED_BDFM` | _(MTA default)_ | No | GTFS-RT feed for B/D/F/M trains |
| `MTA_FEED_ALERTS` | _(MTA default)_ | No | Subway service-alert feed |
| `MTA_BUS_FEED` | _(MTA default)_ | No | MTA Bus Time SIRI base URL |

---

## API endpoints

| Endpoint | Description |
|---|---|
| `GET /api/status` | Full route status + alerts snapshot |
| `GET /api/alerts` | Service alerts only |
| `GET /api/health` | Server health, cache age, config flags |

### `GET /api/status` – response shape

```jsonc
{
  "fetchedAt": "2024-06-01T12:30:00.000Z",  // ISO8601, null if no data yet
  "isStale": false,                           // true when cache > STALE_THRESHOLD_MS
  "error": null,                              // non-null on persistent feed failure
  "routes": {
    "t-1": {
      "status": "Moderate Delays",
      "crowd":  65,                           // 0–100 crowding estimate
      "colorClass": "text-amber-500",
      "bgClass":    "bg-amber-50",
      "note": "Avg delay ~6 min at nearby stops."
    },
    "t-a": { ... },
    "t-c": { ... },
    "t-d": { ... },
    "b-bx15": { ... },
    "b-m100": { ... }
  },
  "alerts": [
    {
      "id": "...",
      "routeIds": ["1"],
      "effect": "SIGNIFICANT_DELAYS",
      "header": "1 Train Delays",
      "description": "Due to a signal problem...",
      "activePeriod": [{ "start": 1700000000, "end": null }]
    }
  ]
}
```

---

## How real-time refresh works

```
MTA GTFS-RT feeds             Backend server                 Browser
─────────────────             ──────────────                 ───────
subway-alerts  ──┐
nyct/gtfs      ──┤  → Poller (every 30 s)  →  in-memory cache  ←──  /api/status (every 30 s)
nyct/gtfs-ace  ──┤       ↳ parse protobuf                               ↓
nyct/gtfs-bdfm ──┘       ↳ compute status                          render UI
Bus SIRI  ──────────────┘    ↳ store snapshot
```

1. **Server start**: the Poller fetches all configured feeds immediately.
2. **Every `POLL_INTERVAL_MS`** (default 30 s): feeds are re-fetched in
   parallel and the cache is updated.
3. **On error**: the Poller retries after a back-off delay; existing cached
   data continues to be served with `isStale: true`.
4. **Browser**: `fetchStatus()` is called once on page load, then again on
   every `REFRESH_INTERVAL_MS` (default 30 s, adjustable via
   `?interval=15000` query param). The UI updates in place without a full
   page reload.
5. **Staleness UX**: if `isStale` is `true` an amber banner appears; if
   `error` is non-null a red banner appears.

---

## Architecture overview

```
/
├── server.js          Express server (API routes + static files)
├── src/
│   ├── mta.js         GTFS-RT fetcher, protobuf decoder, data transformer
│   ├── cache.js       In-memory cache with TTL/staleness tracking
│   └── poller.js      Background poll loop with exponential-backoff retry
├── tests/
│   ├── mta.test.js    Unit tests for transformer / parser logic
│   └── cache.test.js  Unit tests for cache module
├── index.html         Frontend SPA (served as static file by Express)
├── .env.example       Template for required environment variables
└── README.md          This file
```

---

## Running tests

```bash
npm test
```

Tests cover:
- GTFS-RT alert extraction (route filtering, deduplication, effect mapping)
- Trip-update delay parsing (target-stop matching, max-delay aggregation)
- Route status computation (threshold logic, alert severity overrides)
- Bus SIRI response parsing
- Cache TTL and staleness behavior

---

## MTA feed notes & limitations

- **GTFS-Realtime** feeds are binary protobuf (not JSON). The
  `gtfs-realtime-bindings` npm package is used to decode them.
- MTA typically updates subway GTFS-RT feeds every **30 seconds**. Polling
  faster than this wastes bandwidth and can trigger rate limits.
- Bus SIRI (`bustime.mta.info`) is a separate service from the subway feeds
  and requires its own key.
- Crowding data in GTFS-RT is **estimated** from delay patterns and vehicle
  occupancy fields (when populated). It is not a direct sensor reading.
- The MTA API has no advertised rate limit, but as a courtesy the default
  poll interval is 30 s. Do not reduce `POLL_INTERVAL_MS` below ~15 s.
- Feeds may be temporarily unavailable during MTA maintenance windows. The
  app will serve stale data during outages and recover automatically when
  feeds come back.
