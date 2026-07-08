'use strict';

/**
 * tests/mta.test.js
 *
 * Unit tests for the MTA data transformation/parsing layer (src/mta.js).
 * These tests use plain objects to mimic GTFS-RT decoded proto structures
 * without requiring an actual MTA API key.
 */

const {
  extractAlerts,
  extractMaxDelays,
  computeRouteStatuses,
  transformBusStatus,
  _getTranslation,
  _getEffectName,
  ROUTE_ID_MAP,
  STOPS_BY_ROUTE,
} = require('../src/mta');

// ---------------------------------------------------------------------------
// Helpers to build mock GTFS-RT objects
// ---------------------------------------------------------------------------

function makeFeedMessage(entities) {
  return { entity: entities };
}

function makeAlertEntity(id, routeIds, effect, header, description) {
  return {
    id,
    alert: {
      informedEntity: routeIds.map(r => ({ routeId: r })),
      effect,
      headerText: { translation: [{ language: 'en', text: header }] },
      descriptionText: { translation: [{ language: 'en', text: description }] },
      activePeriod: [{ start: 1700000000, end: null }],
    },
  };
}

function makeTripUpdateEntity(id, routeId, stopTimeUpdates) {
  return {
    id,
    tripUpdate: {
      trip: { routeId },
      stopTimeUpdate: stopTimeUpdates,
    },
  };
}

function makeStopTimeUpdate(stopId, departureDelay, arrivalDelay) {
  return {
    stopId,
    departure: departureDelay != null ? { delay: departureDelay } : undefined,
    arrival:   arrivalDelay  != null ? { delay: arrivalDelay  } : undefined,
  };
}

// ---------------------------------------------------------------------------
// extractAlerts
// ---------------------------------------------------------------------------
describe('extractAlerts', () => {
  test('returns empty array for null/undefined input', () => {
    expect(extractAlerts(null)).toEqual([]);
    expect(extractAlerts(undefined)).toEqual([]);
    expect(extractAlerts({})).toEqual([]);
  });

  test('returns empty array when no entities match tracked routes', () => {
    const feed = makeFeedMessage([
      makeAlertEntity('a1', ['Z'], 3, 'Z Train Delays', 'The Z is slow.'),
    ]);
    expect(extractAlerts(feed)).toEqual([]);
  });

  test('extracts an alert for a tracked route', () => {
    const feed = makeFeedMessage([
      makeAlertEntity('a1', ['1'], 3, '1 Train Delays', 'Signal problem near 137th St.'),
    ]);
    const result = extractAlerts(feed);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a1');
    expect(result[0].routeIds).toEqual(['1']);
    expect(result[0].effect).toBe('SIGNIFICANT_DELAYS');
    expect(result[0].header).toBe('1 Train Delays');
    expect(result[0].description).toBe('Signal problem near 137th St.');
  });

  test('deduplicates routeIds within a single alert', () => {
    const feed = makeFeedMessage([
      {
        id: 'a2',
        alert: {
          informedEntity: [
            { routeId: 'A' },
            { routeId: 'A' },
            { routeId: 'C' },
          ],
          effect: 2,
          headerText: { translation: [{ text: 'A/C service change' }] },
          descriptionText: { translation: [{ text: 'Details here.' }] },
          activePeriod: [],
        },
      },
    ]);
    const result = extractAlerts(feed);
    expect(result[0].routeIds).toEqual(['A', 'C']);
  });

  test('skips entities without an alert field', () => {
    const feed = makeFeedMessage([
      { id: 'tu1', tripUpdate: {} },
      makeAlertEntity('a1', ['D'], 1, 'D out of service', ''),
    ]);
    const result = extractAlerts(feed);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a1');
  });

  test('handles missing activePeriod gracefully', () => {
    const entity = makeAlertEntity('a3', ['1'], 3, 'Delays', '');
    delete entity.alert.activePeriod;
    const feed = makeFeedMessage([entity]);
    const result = extractAlerts(feed);
    expect(result[0].activePeriod).toEqual([]);
  });

  test('handles multiple alerts for multiple routes', () => {
    const feed = makeFeedMessage([
      makeAlertEntity('a1', ['1'], 3, '1 Delays', ''),
      makeAlertEntity('a2', ['A', 'C'], 1, 'A/C No Service', ''),
      makeAlertEntity('a3', ['Z'], 3, 'Z Delays', ''),  // not tracked
    ]);
    const result = extractAlerts(feed);
    expect(result).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// extractMaxDelays
// ---------------------------------------------------------------------------
describe('extractMaxDelays', () => {
  test('returns empty object for null/undefined input', () => {
    expect(extractMaxDelays(null)).toEqual({});
    expect(extractMaxDelays(undefined)).toEqual({});
    expect(extractMaxDelays({})).toEqual({});
  });

  test('ignores routes not in STOPS_BY_ROUTE', () => {
    const feed = makeFeedMessage([
      makeTripUpdateEntity('tu1', 'Z', [
        makeStopTimeUpdate('137N', 600),
      ]),
    ]);
    expect(extractMaxDelays(feed)).toEqual({});
  });

  test('ignores stop_time_updates for non-target stops', () => {
    const feed = makeFeedMessage([
      makeTripUpdateEntity('tu1', '1', [
        makeStopTimeUpdate('999N', 600),  // not a CCNY stop
      ]),
    ]);
    expect(extractMaxDelays(feed)).toEqual({});
  });

  test('extracts departure delay at a target stop', () => {
    const feed = makeFeedMessage([
      makeTripUpdateEntity('tu1', '1', [
        makeStopTimeUpdate('137N', 480),
      ]),
    ]);
    expect(extractMaxDelays(feed)).toEqual({ '1': 480 });
  });

  test('falls back to arrival delay when departure is missing', () => {
    const feed = makeFeedMessage([
      makeTripUpdateEntity('tu1', '1', [
        makeStopTimeUpdate('137N', null, 360),
      ]),
    ]);
    expect(extractMaxDelays(feed)).toEqual({ '1': 360 });
  });

  test('tracks max delay across multiple trips for the same route', () => {
    const feed = makeFeedMessage([
      makeTripUpdateEntity('tu1', '1', [makeStopTimeUpdate('137N', 120)]),
      makeTripUpdateEntity('tu2', '1', [makeStopTimeUpdate('137S', 840)]),
      makeTripUpdateEntity('tu3', '1', [makeStopTimeUpdate('137N', 300)]),
    ]);
    expect(extractMaxDelays(feed)).toEqual({ '1': 840 });
  });

  test('handles multiple routes independently', () => {
    const feed = makeFeedMessage([
      makeTripUpdateEntity('tu1', '1', [makeStopTimeUpdate('137N', 200)]),
      makeTripUpdateEntity('tu2', 'A', [makeStopTimeUpdate('A27N', 700)]),
    ]);
    const result = extractMaxDelays(feed);
    expect(result['1']).toBe(200);
    expect(result['A']).toBe(700);
  });

  test('skips entities without tripUpdate', () => {
    const feed = makeFeedMessage([
      makeAlertEntity('a1', ['1'], 3, 'Delays', ''),
      makeTripUpdateEntity('tu1', '1', [makeStopTimeUpdate('137N', 400)]),
    ]);
    expect(extractMaxDelays(feed)).toEqual({ '1': 400 });
  });

  test('skips stop_time_update with no delay fields', () => {
    const feed = makeFeedMessage([
      makeTripUpdateEntity('tu1', '1', [
        { stopId: '137N' },  // no departure or arrival
      ]),
    ]);
    expect(extractMaxDelays(feed)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// computeRouteStatuses
// ---------------------------------------------------------------------------
describe('computeRouteStatuses', () => {
  test('returns Good Service when delays are zero and no alerts', () => {
    const result = computeRouteStatuses({}, []);
    expect(result['t-1'].status).toBe('Good Service');
    expect(result['t-1'].colorClass).toBe('text-emerald-500');
  });

  test('returns Minor Delays when delay is 61–300 s', () => {
    const result = computeRouteStatuses({ '1': 180 }, []);
    expect(result['t-1'].status).toBe('Minor Delays');
  });

  test('returns Moderate Delays when delay is 301–600 s', () => {
    const result = computeRouteStatuses({ '1': 360 }, []);
    expect(result['t-1'].status).toBe('Moderate Delays');
    expect(result['t-1'].colorClass).toBe('text-amber-500');
    expect(result['t-1'].crowd).toBe(65);
  });

  test('returns Severe Delays when delay > 600 s', () => {
    const result = computeRouteStatuses({ '1': 660 }, []);
    expect(result['t-1'].status).toBe('Severe Delays');
    expect(result['t-1'].colorClass).toBe('text-rose-500');
    expect(result['t-1'].crowd).toBe(85);
  });

  test('severe alert overrides delay threshold', () => {
    const alerts = [
      { id: 'a1', routeIds: ['1'], effect: 'NO_SERVICE', header: 'No 1 service', description: '' },
    ];
    const result = computeRouteStatuses({ '1': 0 }, alerts);
    expect(result['t-1'].status).toBe('Severe Delays');
    expect(result['t-1'].note).toBe('No 1 service');
  });

  test('moderate alert upgrades status to Moderate Delays', () => {
    const alerts = [
      { id: 'a1', routeIds: ['1'], effect: 'DETOUR', header: 'Reroute in effect', description: '' },
    ];
    const result = computeRouteStatuses({ '1': 0 }, alerts);
    expect(result['t-1'].status).toBe('Moderate Delays');
  });

  test('A and C trains share the same app route (t-a / t-c) status logic', () => {
    // t-a maps to GTFS 'A'; t-c maps to GTFS 'C'
    const result = computeRouteStatuses({ 'A': 700 }, []);
    expect(result['t-a'].status).toBe('Severe Delays');
    expect(result['t-c'].status).toBe('Good Service'); // C has no delay
  });

  test('includes all subway app routes in output', () => {
    const result = computeRouteStatuses({}, []);
    const subwayIds = ['t-1', 't-a', 't-c', 't-d'];
    subwayIds.forEach(id => {
      expect(result).toHaveProperty(id);
    });
    // Bus routes are NOT included (handled separately)
    expect(result).not.toHaveProperty('b-bx15');
  });
});

// ---------------------------------------------------------------------------
// transformBusStatus
// ---------------------------------------------------------------------------
describe('transformBusStatus', () => {
  test('returns No Bus Data for null/undefined input', () => {
    const result = transformBusStatus(null, 'b-bx15');
    expect(result.status).toBe('No Bus Data');
  });

  test('returns No Bus Data when Siri structure is missing', () => {
    const result = transformBusStatus({}, 'b-bx15');
    expect(result.status).toBe('No Bus Data');
  });

  test('returns No Bus Data when no vehicles are reported', () => {
    const siri = {
      Siri: {
        ServiceDelivery: {
          VehicleMonitoringDelivery: [{ VehicleActivity: [] }],
        },
      },
    };
    const result = transformBusStatus(siri, 'b-bx15');
    expect(result.status).toBe('No Bus Data');
  });

  test('returns Good Service with uncrowded vehicles', () => {
    const siri = {
      Siri: {
        ServiceDelivery: {
          VehicleMonitoringDelivery: [
            {
              VehicleActivity: [
                { MonitoredVehicleJourney: { Occupancy: 'seatsAvailable' } },
                { MonitoredVehicleJourney: { Occupancy: 'seatsAvailable' } },
              ],
            },
          ],
        },
      },
    };
    const result = transformBusStatus(siri, 'b-bx15');
    expect(result.status).toBe('Good Service');
    expect(result.crowd).toBeGreaterThanOrEqual(20);
  });

  test('returns Crowded when most vehicles are full', () => {
    const siri = {
      Siri: {
        ServiceDelivery: {
          VehicleMonitoringDelivery: [
            {
              VehicleActivity: [
                { MonitoredVehicleJourney: { Occupancy: 'full' } },
                { MonitoredVehicleJourney: { Occupancy: 'full' } },
                { MonitoredVehicleJourney: { Occupancy: 'standingAvailable' } },
              ],
            },
          ],
        },
      },
    };
    const result = transformBusStatus(siri, 'b-bx15');
    expect(result.status).toBe('Crowded');
    expect(result.crowd).toBeGreaterThan(60);
  });
});

// ---------------------------------------------------------------------------
// _getTranslation (internal helper)
// ---------------------------------------------------------------------------
describe('_getTranslation', () => {
  test('returns empty string for null', () => {
    expect(_getTranslation(null)).toBe('');
    expect(_getTranslation(undefined)).toBe('');
  });

  test('returns en translation when available', () => {
    const ts = { translation: [{ language: 'es', text: 'Hola' }, { language: 'en', text: 'Hello' }] };
    expect(_getTranslation(ts)).toBe('Hello');
  });

  test('falls back to first translation if no en entry', () => {
    const ts = { translation: [{ language: 'es', text: 'Hola' }] };
    expect(_getTranslation(ts)).toBe('Hola');
  });

  test('handles entry with no language field', () => {
    const ts = { translation: [{ text: 'No language' }] };
    expect(_getTranslation(ts)).toBe('No language');
  });
});

// ---------------------------------------------------------------------------
// _getEffectName (internal helper)
// ---------------------------------------------------------------------------
describe('_getEffectName', () => {
  test('maps known numeric effects to string names', () => {
    expect(_getEffectName(1)).toBe('NO_SERVICE');
    expect(_getEffectName(3)).toBe('SIGNIFICANT_DELAYS');
    expect(_getEffectName(10)).toBe('NO_EFFECT');
  });

  test('returns UNKNOWN_EFFECT for unknown values', () => {
    expect(_getEffectName(99)).toBe('UNKNOWN_EFFECT');
    expect(_getEffectName(null)).toBe('UNKNOWN_EFFECT');
    expect(_getEffectName(undefined)).toBe('UNKNOWN_EFFECT');
  });
});

// ---------------------------------------------------------------------------
// ROUTE_ID_MAP and STOPS_BY_ROUTE sanity checks
// ---------------------------------------------------------------------------
describe('ROUTE_ID_MAP', () => {
  test('covers all app route IDs', () => {
    const expected = ['t-1', 't-a', 't-c', 't-d', 'b-bx15', 'b-m100'];
    expected.forEach(id => expect(ROUTE_ID_MAP).toHaveProperty(id));
  });

  test('maps t-1 to 1 train GTFS id', () => {
    expect(ROUTE_ID_MAP['t-1']).toContain('1');
  });
});

describe('STOPS_BY_ROUTE', () => {
  test('includes 137th St stops for route 1', () => {
    expect(STOPS_BY_ROUTE['1']).toContain('137N');
    expect(STOPS_BY_ROUTE['1']).toContain('137S');
  });

  test('includes 145th St stops for A/C route', () => {
    expect(STOPS_BY_ROUTE['A']).toContain('A27N');
    expect(STOPS_BY_ROUTE['C']).toContain('A27S');
  });
});
