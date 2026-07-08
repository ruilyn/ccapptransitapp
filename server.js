'use strict';

/**
 * server.js – Smart Route Guardian backend
 *
 * Serves the frontend (index.html) and exposes three JSON endpoints:
 *
 *   GET /api/status  – Latest MTA route statuses + alerts for the CCNY area
 *   GET /api/alerts  – Service alerts only (subset of /api/status)
 *   GET /api/health  – Health check with cache age and config summary
 *
 * The background Poller fetches MTA GTFS-RT feeds on a configurable interval
 * and stores results in an in-memory cache.  All frontend requests are served
 * from that cache so the MTA API is never hit per-user-request.
 */

require('dotenv').config();

const path = require('path');
const express = require('express');
const Cache = require('./src/cache');
const Poller = require('./src/poller');

// ---------------------------------------------------------------------------
// Configuration (from environment variables with sane defaults)
// ---------------------------------------------------------------------------
const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  mtaApiKey: process.env.MTA_API_KEY || '',
  mtaBusApiKey: process.env.MTA_BUS_API_KEY || '',
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '30000', 10),
  staleThresholdMs: parseInt(process.env.STALE_THRESHOLD_MS || '90000', 10),
  fetchTimeoutMs: parseInt(process.env.FETCH_TIMEOUT_MS || '10000', 10),
  maxRetries: parseInt(process.env.MAX_RETRIES || '3', 10),
  feedUrls: {
    alerts: process.env.MTA_FEED_ALERTS ||
      'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts',
    feed123: process.env.MTA_FEED_123456 ||
      'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs',
    feedAce: process.env.MTA_FEED_ACE ||
      'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace',
    feedBdfm: process.env.MTA_FEED_BDFM ||
      'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm',
    busFeed: process.env.MTA_BUS_FEED ||
      'http://bustime.mta.info/api/siri/vehicle-monitoring.json',
  },
};

// Warn early if the key is missing
if (!config.mtaApiKey || config.mtaApiKey === 'your_mta_api_key_here') {
  console.warn(
    '[Config] WARNING: MTA_API_KEY is not set. ' +
    'Subway feeds will fail. Set it in .env (see .env.example).'
  );
}

// ---------------------------------------------------------------------------
// Shared cache & poller
// ---------------------------------------------------------------------------
const cache = new Cache(config.staleThresholdMs);
const poller = new Poller(cache, config);

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();

// Serve the frontend
app.use(express.static(path.join(__dirname)));

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

/**
 * GET /api/status
 *
 * Returns the full status payload consumed by the frontend:
 * {
 *   fetchedAt:  string | null,
 *   isStale:    boolean,
 *   error:      string | null,
 *   routes:     { [appRouteId]: RouteStatus },
 *   alerts:     Alert[]
 * }
 */
app.get('/api/status', (req, res) => {
  const data = cache.get();

  if (!data) {
    // Nothing in cache yet (first poll hasn't finished or key is missing)
    return res.json({
      fetchedAt: null,
      isStale: false,
      error: config.mtaApiKey ? 'Fetching data – please wait a moment.' : 'MTA_API_KEY not configured.',
      routes: {},
      alerts: [],
    });
  }

  res.json({
    fetchedAt: cache.fetchedAt(),
    isStale: cache.isStale(),
    error: data._error || null,
    routes: data.routes || {},
    alerts: data.alerts || [],
  });
});

/**
 * GET /api/alerts
 *
 * Service alerts only.
 */
app.get('/api/alerts', (req, res) => {
  const data = cache.get();
  res.json({
    fetchedAt: cache.fetchedAt(),
    alerts: (data && data.alerts) || [],
  });
});

/**
 * GET /api/health
 *
 * Health check endpoint – useful for monitoring.
 */
app.get('/api/health', (req, res) => {
  const data = cache.get();
  res.json({
    status: 'ok',
    cacheAgeMs: cache.ageMs() === Infinity ? null : cache.ageMs(),
    isStale: cache.isStale(),
    hasMtaKey: Boolean(config.mtaApiKey && config.mtaApiKey !== 'your_mta_api_key_here'),
    hasBusKey: Boolean(config.mtaBusApiKey && config.mtaBusApiKey !== 'your_mta_bus_api_key_here'),
    pollIntervalMs: config.pollIntervalMs,
    hasData: !cache.isEmpty(),
    lastError: (data && data._error) || null,
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(config.port, () => {
  console.log(`[Server] Smart Route Guardian running on http://localhost:${config.port}`);
  console.log(`[Server] Polling MTA every ${config.pollIntervalMs / 1000}s`);
  poller.start();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  poller.stop();
  process.exit(0);
});
process.on('SIGINT', () => {
  poller.stop();
  process.exit(0);
});

module.exports = app; // export for testing
