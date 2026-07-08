'use strict';

/**
 * src/cache.js
 *
 * Simple in-memory cache for MTA feed snapshots.
 * Tracks when data was last set and exposes a staleness check.
 */

class Cache {
  /**
   * @param {number} staleThresholdMs  - Age (ms) after which data is "stale"
   */
  constructor(staleThresholdMs = 90000) {
    this._data = null;
    this._timestamp = null;
    this._staleThresholdMs = staleThresholdMs;
  }

  /** Store a new snapshot. */
  set(data) {
    this._data = data;
    this._timestamp = Date.now();
  }

  /** Return the cached data object, or null if nothing has been stored yet. */
  get() {
    return this._data;
  }

  /** Milliseconds since the last update, or Infinity if never set. */
  ageMs() {
    return this._timestamp == null ? Infinity : Date.now() - this._timestamp;
  }

  /** ISO8601 string of the last fetch timestamp, or null. */
  fetchedAt() {
    return this._timestamp ? new Date(this._timestamp).toISOString() : null;
  }

  /** True when data exists but is older than staleThresholdMs. */
  isStale() {
    return this._data != null && this.ageMs() > this._staleThresholdMs;
  }

  /** True when no data has ever been stored. */
  isEmpty() {
    return this._data == null;
  }

  /** Update the stale threshold (useful for runtime config changes). */
  setStaleThreshold(ms) {
    this._staleThresholdMs = ms;
  }
}

module.exports = Cache;
