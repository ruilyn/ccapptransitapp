/**
 * MTA GTFS-Realtime integration.
 *
 * The MTA publishes free, keyless GTFS-Realtime (protobuf) feeds for every
 * subway division at https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/.
 * These feeds cannot be read directly from a browser (binary protobuf + no
 * CORS headers), so this module fetches and decodes them on the server and
 * exposes a small, cached JSON summary that the frontend can poll.
 *
 * NOTE on stop IDs: the CCNY-area `stopId` values below are the standard
 * GTFS `stops.txt` identifiers for the relevant stations (137 St-City
 * College, 125 St and 145 St). If the MTA ever renumbers stops, update the
 * IDs in `ROUTES` below - the rest of the pipeline does not need to change.
 */

const GtfsRealtimeBindings = require('gtfs-realtime-bindings');

const FEED_BASE = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds';

// Which raw GTFS-RT feed each subway route is published under.
const FEEDS = {
  numbered: `${FEED_BASE}/nyct%2Fgtfs`, // 1,2,3,4,5,6,7,S
  ace: `${FEED_BASE}/nyct%2Fgtfs-ace`, // A,C,E
  bdfm: `${FEED_BASE}/nyct%2Fgtfs-bdfm`, // B,D,F,M
  alerts: `${FEED_BASE}/camsys%2Fsubway-alerts`, // Real-time alerts
};

// Routes the app cares about for the CCNY campus, mapped to the feed that
// carries them and the nearby station stop_id (base id, without the N/S
// direction suffix that GTFS-RT appends).
const ROUTES = {
  't-1': { route: '1', feed: 'numbered', stopId: '137', label: '137th St-City College' },
  't-a': { route: 'A', feed: 'ace', stopId: 'A15', label: '145th St' },
  't-c': { route: 'C', feed: 'ace', stopId: 'A15', label: '145th St' },
  't-d': { route: 'D', feed: 'bdfm', stopId: 'A32', label: '125th St' },
};

const FEED_CACHE_MS = 25_000; // MTA feeds refresh roughly every 30s
const feedCache = new Map(); // feedKey -> { fetchedAt, data }

async function fetchFeed(feedKey) {
  const cached = feedCache.get(feedKey);
  if (cached && Date.now() - cached.fetchedAt < FEED_CACHE_MS) {
    return cached.data;
  }

  const url = FEEDS[feedKey];
  const response = await fetch(url, {
    headers: { accept: 'application/x-protobuf' },
  });

  if (!response.ok) {
    throw new Error(`MTA feed request failed (${response.status}) for ${feedKey}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);

  feedCache.set(feedKey, { fetchedAt: Date.now(), data: feed });
  return feed;
}

/**
 * Pulls upcoming arrivals for a route at a given stop out of a decoded
 * GTFS-RT feed, along with a schedule-adherence delay figure (seconds).
 */
function extractArrivals(feed, routeId, stopId) {
  const now = Date.now() / 1000;
  const arrivals = [];
  let maxDelaySeconds = 0;

  for (const entity of feed.entity) {
    const tripUpdate = entity.tripUpdate;
    if (!tripUpdate || tripUpdate.trip.routeId !== routeId) continue;

    for (const stu of tripUpdate.stopTimeUpdate || []) {
      if (!stu.stopId || !stu.stopId.startsWith(stopId)) continue;

      const arrivalTime = stu.arrival?.time ? Number(stu.arrival.time) : null;
      const delay = stu.arrival?.delay ?? stu.departure?.delay ?? 0;
      maxDelaySeconds = Math.max(maxDelaySeconds, delay);

      if (arrivalTime && arrivalTime >= now) {
        arrivals.push({
          minutesAway: Math.max(0, Math.round((arrivalTime - now) / 60)),
          delaySeconds: delay,
        });
      }
    }
  }

  arrivals.sort((a, b) => a.minutesAway - b.minutesAway);
  return { arrivals: arrivals.slice(0, 3), maxDelaySeconds };
}

/**
 * Converts raw arrival/delay data into the status shape the frontend
 * expects: a human status label, a 0-100 "crowd" estimate, and a note.
 *
 * The GTFS-RT trip updates feed doesn't publish rider-counted crowding, so
 * we derive a reasonable proxy from two real signals: how bunched the
 * upcoming trains are (a large gap after the next train suggests the
 * previous one is overloaded) and live schedule delay.
 */

/**
 * Extracts currently active alerts for a specific route.
 */
function extractAlerts(feed, routeId) {
  if (!feed || !feed.entity) return [];
  const activeAlerts = [];
  const now = Date.now() / 1000;

  for (const entity of feed.entity) {
    if (!entity.alert) continue;

    // Check if alert affects our route
    const affectsRoute = Array.isArray(entity.alert.informedEntity) && entity.alert.informedEntity.some((e) => e.routeId === routeId);
    if (!affectsRoute) continue;

    // Check if alert is currently active
    let isActive = true;
    if (entity.alert.activePeriod && entity.alert.activePeriod.length > 0) {
      isActive = entity.alert.activePeriod.some((period) => {
        const start = period.start ? Number(period.start) : 0;
        const end = period.end ? Number(period.end) : Infinity;
        return now >= start && now <= end;
      });
    }

    if (isActive) {
      const translations = entity.alert.headerText?.translation || [];
      const englishTranslation = translations.find((t) => t.language === 'en' || t.language === 'en-US');
      const headerText = englishTranslation ? englishTranslation.text : (translations[0]?.text || '');
      
      if (headerText) {
        activeAlerts.push(headerText.trim());
      }
    }
  }

  return activeAlerts;
}

function computeStatus({ arrivals, maxDelaySeconds, routeAlerts = [] }) {
  const delayMinutes = maxDelaySeconds / 60;
  const gapMinutes = arrivals.length >= 2 ? arrivals[1].minutesAway - arrivals[0].minutesAway : 6;

  let crowd = Math.min(95, Math.round(30 + gapMinutes * 6 + delayMinutes * 4));
  crowd = Math.max(10, crowd);

  let status = 'Good Service';
  let note = 'Trains running on a regular schedule.';

  if (routeAlerts.length > 0) {
    status = 'Service Alert';
    note = routeAlerts.slice(0, 2).join(' • ') + (routeAlerts.length > 2 ? ` (+${routeAlerts.length - 2} more)` : '');
  } else if (delayMinutes >= 8) {
    status = 'Severe Delays';
    note = `Trains running about ${Math.round(delayMinutes)} min behind schedule.`;
  } else if (delayMinutes >= 3 || gapMinutes >= 10) {
    status = 'Moderate Delays';
    note = gapMinutes >= 10
      ? `Longer wait than usual (${gapMinutes} min gap) - expect a fuller train.`
      : `Minor delays of about ${Math.round(delayMinutes)} min.`;
  } else if (gapMinutes >= 7) {
    status = 'Crowded';
    note = 'Trains are spaced further apart than usual.';
  }

  return { status, crowd, note };
}

/**
 * Fetches and summarizes live status for every tracked route. Falls back
 * gracefully (per-route) if a single feed request fails, so one bad feed
 * doesn't take down the whole dashboard.
 */
async function getLiveStatus() {
  const feedKeysNeeded = [...new Set(Object.values(ROUTES).map((r) => r.feed)), 'alerts'];
  const feeds = {};

  await Promise.all(
    feedKeysNeeded.map(async (feedKey) => {
      try {
        feeds[feedKey] = await fetchFeed(feedKey);
      } catch (err) {
        feeds[feedKey] = { error: err.message };
      }
    })
  );

  const result = {};
  for (const [id, cfg] of Object.entries(ROUTES)) {
    const feed = feeds[cfg.feed];
    if (!feed || feed.error) {
      result[id] = {
        status: 'Data Unavailable',
        crowd: null,
        note: 'Could not reach the MTA real-time feed. Showing last known info.',
        arrivals: [],
        source: 'error',
      };
      continue;
    }

    const { arrivals, maxDelaySeconds } = extractArrivals(feed, cfg.route, cfg.stopId);
    const routeAlerts = extractAlerts(feeds['alerts'], cfg.route);
    const status = computeStatus({ arrivals, maxDelaySeconds, routeAlerts });

    result[id] = {
      ...status,
      arrivals,
      station: cfg.label,
      source: 'mta-gtfs-realtime',
      updatedAt: new Date().toISOString(),
    };
  }

  return result;
}

module.exports = { getLiveStatus, ROUTES };
