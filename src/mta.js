'use strict';

/**
 * src/mta.js
 *
 * MTA GTFS-Realtime feed client and data transformer.
 *
 * Responsibilities:
 *  - Fetch binary protobuf feeds from MTA endpoints
 *  - Decode them with gtfs-realtime-bindings
 *  - Transform raw feed entities into app-friendly route-status objects
 */

const fetch = require('node-fetch');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');

// ---------------------------------------------------------------------------
// Constants – stop IDs for CCNY-proximate stations
// ---------------------------------------------------------------------------

/** Maps our internal route IDs to GTFS route_id values. */
const ROUTE_ID_MAP = {
  't-1': ['1'],
  't-a': ['A'],
  't-c': ['C'],
  't-d': ['D'],
  'b-bx15': ['Bx15'],
  'b-m100': ['M100'],
};

/**
 * Target stop IDs we care about, grouped by route cluster.
 * Northbound/southbound variants are both tracked.
 */
const STOPS_BY_ROUTE_CLUSTER = {
  '123': ['137N', '137S'],              // 137th St – City College (1 train)
  'ace': ['A27N', 'A27S', 'A20N', 'A20S'], // 145th St, 125th St (A/C)
  'bdfm': ['D13N', 'D13S', 'D14N', 'D14S'], // 145th St, 125th St (B/D)
};

/** All subway stop IDs we watch, keyed by GTFS route_id for quick lookup. */
const STOPS_BY_ROUTE = {
  '1': ['137N', '137S'],
  'A': ['A27N', 'A27S', 'A20N', 'A20S'],
  'C': ['A27N', 'A27S', 'A20N', 'A20S'],
  'D': ['D13N', 'D13S', 'D14N', 'D14S'],
  'B': ['D13N', 'D13S', 'D14N', 'D14S'],
};

// ---------------------------------------------------------------------------
// Feed fetch helpers
// ---------------------------------------------------------------------------

/**
 * Fetch a GTFS-Realtime feed and return the decoded FeedMessage.
 *
 * @param {string} url        - Full feed URL
 * @param {string} apiKey     - MTA API key for x-api-key header
 * @param {number} timeoutMs  - Request timeout in milliseconds
 * @returns {Promise<Object>} - Decoded FeedMessage protobuf object
 */
async function fetchFeed(url, apiKey, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: { 'x-api-key': apiKey },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${url}`);
    }

    const buffer = await response.buffer();
    return GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the MTA Bus Time SIRI vehicle-monitoring endpoint.
 *
 * @param {string} baseUrl  - Base bus feed URL
 * @param {string} apiKey   - Bus API key
 * @param {string} lineRef  - SIRI LineRef (e.g. "MTA NYCT_Bx15")
 * @param {number} timeoutMs
 * @returns {Promise<Object>} - Parsed JSON response
 */
async function fetchBusFeed(baseUrl, apiKey, lineRef, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const url = `${baseUrl}?key=${encodeURIComponent(apiKey)}&LineRef=${encodeURIComponent(lineRef)}&VehicleMonitoringDetailLevel=basic`;

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${url}`);
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Transformers – GTFS-RT → app-friendly shape
// ---------------------------------------------------------------------------

/**
 * Extract service alerts relevant to our tracked routes.
 *
 * @param {Object} feedMessage - Decoded GTFS-RT FeedMessage
 * @returns {Array<Object>}    - Normalized alert objects
 */
function extractAlerts(feedMessage) {
  if (!feedMessage || !feedMessage.entity) return [];

  const alerts = [];
  const trackedGtfsIds = new Set(
    Object.values(ROUTE_ID_MAP).flat()
  );

  for (const entity of feedMessage.entity) {
    if (!entity.alert) continue;
    const alert = entity.alert;

    // Collect route IDs from informedEntity
    const routeIds = (alert.informedEntity || [])
      .filter((ie) => ie.routeId && trackedGtfsIds.has(ie.routeId))
      .map((ie) => ie.routeId);

    if (routeIds.length === 0) continue;

    const header = getTranslation(alert.headerText);
    const description = getTranslation(alert.descriptionText);
    const effect = getEffectName(alert.effect);

    alerts.push({
      id: entity.id,
      routeIds: [...new Set(routeIds)],
      effect,
      header: header || '',
      description: description || '',
      activePeriod: (alert.activePeriod || []).map((ap) => ({
        start: ap.start ? Number(ap.start) : null,
        end: ap.end ? Number(ap.end) : null,
      })),
    });
  }

  return alerts;
}

/**
 * Extract the maximum stop-level delay (seconds) per GTFS route_id
 * at the CCNY-proximate stops.
 *
 * @param {Object} feedMessage - Decoded GTFS-RT FeedMessage
 * @returns {Object} Map of gtfsRouteId → maxDelaySeconds (number)
 */
function extractMaxDelays(feedMessage) {
  if (!feedMessage || !feedMessage.entity) return {};

  const maxDelays = {}; // gtfsRouteId → max delay in seconds

  for (const entity of feedMessage.entity) {
    if (!entity.tripUpdate) continue;
    const tu = entity.tripUpdate;
    const routeId = tu.trip && tu.trip.routeId;
    if (!routeId) continue;

    const targetStops = STOPS_BY_ROUTE[routeId];
    if (!targetStops) continue; // not a route we care about

    for (const stu of tu.stopTimeUpdate || []) {
      if (!targetStops.includes(stu.stopId)) continue;

      // departure delay takes priority; fall back to arrival delay
      const delay =
        (stu.departure && stu.departure.delay != null
          ? Number(stu.departure.delay)
          : null) ||
        (stu.arrival && stu.arrival.delay != null
          ? Number(stu.arrival.delay)
          : null);

      if (delay == null) continue;

      if (maxDelays[routeId] == null || delay > maxDelays[routeId]) {
        maxDelays[routeId] = delay;
      }
    }
  }

  return maxDelays;
}

/**
 * Given alerts and max-delay maps (keyed by GTFS route_id), produce a
 * per-app-route status object.
 *
 * @param {Object} maxDelays  - { gtfsRouteId: maxDelaySeconds }
 * @param {Array}  alerts     - Normalized alert objects from extractAlerts()
 * @returns {Object}          - { appRouteId: RouteStatus }
 */
function computeRouteStatuses(maxDelays, alerts) {
  const result = {};

  for (const [appId, gtfsIds] of Object.entries(ROUTE_ID_MAP)) {
    // Bus routes handled separately
    if (appId.startsWith('b-')) continue;

    // Gather the worst delay across all GTFS route IDs for this app route
    let worstDelay = 0;
    for (const gid of gtfsIds) {
      if (maxDelays[gid] != null && maxDelays[gid] > worstDelay) {
        worstDelay = maxDelays[gid];
      }
    }

    // Check for active severe alerts on these routes
    const routeAlerts = alerts.filter((a) =>
      gtfsIds.some((gid) => a.routeIds.includes(gid))
    );
    const hasSevereAlert = routeAlerts.some(
      (a) => a.effect === 'NO_SERVICE' || a.effect === 'SIGNIFICANT_DELAYS'
    );
    const hasModerateAlert = routeAlerts.some(
      (a) =>
        a.effect === 'REDUCED_SERVICE' ||
        a.effect === 'MODIFIED_SERVICE' ||
        a.effect === 'DETOUR'
    );

    let status, colorClass, bgClass, crowd;
    let note =
      routeAlerts.length > 0 ? routeAlerts[0].header : '';

    if (hasSevereAlert || worstDelay > 600) {
      status = 'Severe Delays';
      colorClass = 'text-rose-500';
      bgClass = 'bg-rose-50';
      crowd = 85;
      if (!note && worstDelay > 600) {
        note = `Avg delay ~${Math.round(worstDelay / 60)} min at nearby stops.`;
      }
    } else if (hasModerateAlert || worstDelay > 300) {
      status = 'Moderate Delays';
      colorClass = 'text-amber-500';
      bgClass = 'bg-amber-50';
      crowd = 65;
      if (!note && worstDelay > 300) {
        note = `Avg delay ~${Math.round(worstDelay / 60)} min at nearby stops.`;
      }
    } else if (worstDelay > 60) {
      status = 'Minor Delays';
      colorClass = 'text-amber-400';
      bgClass = 'bg-amber-50';
      crowd = 45;
      if (!note) note = 'Minor delays. Normal service expected shortly.';
    } else {
      status = 'Good Service';
      colorClass = 'text-emerald-500';
      bgClass = 'bg-emerald-50';
      crowd = 25;
      if (!note) note = 'Normal service. Light crowds.';
    }

    result[appId] = { status, colorClass, bgClass, crowd, note };
  }

  return result;
}

/**
 * Parse SIRI bus vehicle-monitoring response and return a status
 * summary for the route.
 *
 * @param {Object} siriData  - Parsed SIRI JSON
 * @param {string} appRouteId
 * @returns {Object}         - RouteStatus
 */
function transformBusStatus(siriData, appRouteId) {
  try {
    const delivery =
      siriData &&
      siriData.Siri &&
      siriData.Siri.ServiceDelivery &&
      siriData.Siri.ServiceDelivery.VehicleMonitoringDelivery;

    const vehicles = Array.isArray(delivery)
      ? delivery.flatMap((d) => d.VehicleActivity || [])
      : [];

    if (vehicles.length === 0) {
      return {
        status: 'No Bus Data',
        colorClass: 'text-slate-400',
        bgClass: 'bg-slate-50',
        crowd: 0,
        note: 'No active vehicles reported.',
      };
    }

    // Count vehicles with overload occupancy
    const crowdedCount = vehicles.filter((v) => {
      const occ =
        v.MonitoredVehicleJourney &&
        v.MonitoredVehicleJourney.Occupancy;
      return occ === 'full' || occ === 'standingAvailable';
    }).length;

    const crowdRatio = crowdedCount / vehicles.length;
    const crowd = Math.round(20 + crowdRatio * 70); // 20–90 range

    let status, colorClass, bgClass, note;
    if (crowdRatio > 0.6) {
      status = 'Crowded';
      colorClass = 'text-amber-500';
      bgClass = 'bg-amber-50';
      note = 'Multiple buses running at capacity.';
    } else {
      status = 'Good Service';
      colorClass = 'text-emerald-500';
      bgClass = 'bg-emerald-50';
      note = `${vehicles.length} active vehicles on route.`;
    }

    return { status, colorClass, bgClass, crowd, note };
  } catch {
    return {
      status: 'No Bus Data',
      colorClass: 'text-slate-400',
      bgClass: 'bg-slate-50',
      crowd: 0,
      note: 'Unable to parse bus data.',
    };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Return the English translation text from a TranslatedString proto. */
function getTranslation(translatedString) {
  if (!translatedString || !translatedString.translation) return '';
  const en = translatedString.translation.find(
    (t) => !t.language || t.language === 'en'
  );
  return (en || translatedString.translation[0] || { text: '' }).text;
}

/** Convert numeric alert Effect enum to a readable string. */
function getEffectName(effect) {
  const effects = {
    1: 'NO_SERVICE',
    2: 'REDUCED_SERVICE',
    3: 'SIGNIFICANT_DELAYS',
    4: 'DETOUR',
    5: 'ADDITIONAL_SERVICE',
    6: 'MODIFIED_SERVICE',
    7: 'OTHER_EFFECT',
    8: 'UNKNOWN_EFFECT',
    9: 'STOP_MOVED',
    10: 'NO_EFFECT',
    11: 'ACCESSIBILITY_ISSUE',
  };
  return (effect != null && effects[effect]) || 'UNKNOWN_EFFECT';
}

module.exports = {
  fetchFeed,
  fetchBusFeed,
  extractAlerts,
  extractMaxDelays,
  computeRouteStatuses,
  transformBusStatus,
  // Export internals for testing
  _getTranslation: getTranslation,
  _getEffectName: getEffectName,
  ROUTE_ID_MAP,
  STOPS_BY_ROUTE,
};
