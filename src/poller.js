'use strict';

/**
 * src/poller.js
 *
 * Background MTA feed poller with exponential-backoff retry.
 *
 * On each cycle the poller:
 *  1. Fetches the subway alert feed + trip-update feeds for our lines
 *  2. (Optionally) fetches the bus feed for Bx15
 *  3. Transforms raw data into the app-status shape
 *  4. Stores the result in the shared cache
 *
 * Retry behavior:
 *  - On a fetch/parse error, retries after RETRY_DELAYS_MS[attempt] ms
 *  - After MAX_RETRIES consecutive errors, marks the cache with an error flag
 *  - A successful fetch resets the consecutive-error counter
 */

const {
  fetchFeed,
  fetchBusFeed,
  extractAlerts,
  extractMaxDelays,
  computeRouteStatuses,
  transformBusStatus,
} = require('./mta');

const RETRY_DELAYS_MS = [5000, 15000, 30000]; // escalating back-off

class Poller {
  /**
   * @param {Cache}  cache   - Shared Cache instance
   * @param {Object} config  - Runtime configuration
   */
  constructor(cache, config = {}) {
    this._cache = cache;
    this._config = config;
    this._timer = null;
    this._running = false;
    this._consecutiveErrors = 0;
  }

  /** Start polling immediately, then on every POLL_INTERVAL_MS. */
  start() {
    if (this._running) return;
    this._running = true;
    this._poll();
  }

  /** Stop the polling loop. */
  stop() {
    this._running = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  async _poll() {
    if (!this._running) return;

    try {
      const data = await this._fetchAll();
      this._cache.set(data);
      this._consecutiveErrors = 0;
      this._scheduleNext(this._config.pollIntervalMs || 30000);
    } catch (err) {
      this._consecutiveErrors += 1;
      const maxRetries = this._config.maxRetries ?? 3;
      const delay =
        RETRY_DELAYS_MS[Math.min(this._consecutiveErrors - 1, RETRY_DELAYS_MS.length - 1)];

      console.error(
        `[Poller] Error #${this._consecutiveErrors}:`,
        err.message,
        `– retrying in ${delay / 1000}s`
      );

      // After max retries, store an error marker but keep stale data
      if (this._consecutiveErrors >= maxRetries) {
        const existing = this._cache.get();
        this._cache.set({
          ...(existing || {}),
          _error: err.message,
          _errorAt: new Date().toISOString(),
        });
      }

      this._scheduleNext(delay);
    }
  }

  _scheduleNext(delayMs) {
    if (!this._running) return;
    this._timer = setTimeout(() => this._poll(), delayMs);
  }

  /** Fetch all feeds and return the merged status object. */
  async _fetchAll() {
    const {
      mtaApiKey,
      mtaBusApiKey,
      feedUrls = {},
      fetchTimeoutMs = 10000,
    } = this._config;

    // Fetch subway feeds in parallel
    const [alertFeed, feed123, feedAce, feedBdfm] = await Promise.all([
      safeFetch(() => fetchFeed(feedUrls.alerts, mtaApiKey, fetchTimeoutMs)),
      safeFetch(() => fetchFeed(feedUrls.feed123, mtaApiKey, fetchTimeoutMs)),
      safeFetch(() => fetchFeed(feedUrls.feedAce, mtaApiKey, fetchTimeoutMs)),
      safeFetch(() => fetchFeed(feedUrls.feedBdfm, mtaApiKey, fetchTimeoutMs)),
    ]);

    // At least one subway feed must succeed
    if (!alertFeed && !feed123 && !feedAce && !feedBdfm) {
      throw new Error('All subway feeds failed to load.');
    }

    // Merge alerts
    const alerts = alertFeed ? extractAlerts(alertFeed) : [];

    // Merge delay maps from all trip-update feeds
    const maxDelays = {};
    for (const feed of [feed123, feedAce, feedBdfm]) {
      if (!feed) continue;
      const delays = extractMaxDelays(feed);
      for (const [routeId, delay] of Object.entries(delays)) {
        if (maxDelays[routeId] == null || delay > maxDelays[routeId]) {
          maxDelays[routeId] = delay;
        }
      }
    }

    // Build per-route statuses
    const routes = computeRouteStatuses(maxDelays, alerts);

    // Bus data (Bx15 and M100) – best-effort, optional
    if (mtaBusApiKey && feedUrls.busFeed) {
      const bx15Data = await safeFetch(() =>
        fetchBusFeed(feedUrls.busFeed, mtaBusApiKey, 'MTA NYCT_Bx15', fetchTimeoutMs)
      );
      routes['b-bx15'] = bx15Data
        ? transformBusStatus(bx15Data, 'b-bx15')
        : noBusStatus();

      const m100Data = await safeFetch(() =>
        fetchBusFeed(feedUrls.busFeed, mtaBusApiKey, 'MTA NYCT_M100', fetchTimeoutMs)
      );
      routes['b-m100'] = m100Data
        ? transformBusStatus(m100Data, 'b-m100')
        : noBusStatus();
    } else {
      routes['b-bx15'] = noBusStatus();
      routes['b-m100'] = noBusStatus();
    }

    return { routes, alerts };
  }
}

/** Call fn(); return null instead of throwing on any error. */
async function safeFetch(fn) {
  try {
    return await fn();
  } catch (err) {
    console.warn('[Poller] Feed error (non-fatal):', err.message);
    return null;
  }
}

function noBusStatus() {
  return {
    status: 'No Bus Data',
    colorClass: 'text-slate-400',
    bgClass: 'bg-slate-50',
    crowd: 0,
    note: 'Bus API key not configured.',
  };
}


module.exports = Poller;
