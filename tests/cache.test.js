'use strict';

/**
 * tests/cache.test.js
 *
 * Unit tests for the in-memory Cache module (src/cache.js).
 */

const Cache = require('../src/cache');

describe('Cache', () => {
  let cache;

  beforeEach(() => {
    cache = new Cache(5000); // 5-second stale threshold
  });

  test('isEmpty() is true when nothing has been stored', () => {
    expect(cache.isEmpty()).toBe(true);
  });

  test('get() returns null before first set()', () => {
    expect(cache.get()).toBeNull();
  });

  test('fetchedAt() returns null before first set()', () => {
    expect(cache.fetchedAt()).toBeNull();
  });

  test('ageMs() returns Infinity before first set()', () => {
    expect(cache.ageMs()).toBe(Infinity);
  });

  test('isStale() returns false when cache is empty', () => {
    expect(cache.isStale()).toBe(false);
  });

  test('stores and retrieves data', () => {
    const data = { routes: { 't-1': { status: 'Good Service' } }, alerts: [] };
    cache.set(data);
    expect(cache.get()).toEqual(data);
  });

  test('isEmpty() is false after set()', () => {
    cache.set({ foo: 'bar' });
    expect(cache.isEmpty()).toBe(false);
  });

  test('fetchedAt() returns ISO string after set()', () => {
    cache.set({});
    const ts = cache.fetchedAt();
    expect(ts).not.toBeNull();
    expect(() => new Date(ts)).not.toThrow();
  });

  test('ageMs() is small immediately after set()', () => {
    cache.set({});
    expect(cache.ageMs()).toBeLessThan(100);
  });

  test('isStale() returns false immediately after set()', () => {
    cache.set({});
    expect(cache.isStale()).toBe(false);
  });

  test('isStale() returns true after threshold is exceeded', () => {
    jest.useFakeTimers();
    cache.set({ data: 'old' });
    jest.advanceTimersByTime(6000); // past 5-second threshold
    expect(cache.isStale()).toBe(true);
    jest.useRealTimers();
  });

  test('isStale() returns false just before threshold', () => {
    jest.useFakeTimers();
    cache.set({ data: 'fresh' });
    jest.advanceTimersByTime(4999);
    expect(cache.isStale()).toBe(false);
    jest.useRealTimers();
  });

  test('set() resets staleness after re-population', () => {
    jest.useFakeTimers();
    cache.set({ data: 'old' });
    jest.advanceTimersByTime(6000);
    expect(cache.isStale()).toBe(true);
    cache.set({ data: 'fresh' }); // refresh
    expect(cache.isStale()).toBe(false);
    jest.useRealTimers();
  });

  test('setStaleThreshold() updates threshold', () => {
    jest.useFakeTimers();
    cache.set({});
    jest.advanceTimersByTime(3000);
    expect(cache.isStale()).toBe(false); // 3s < 5s threshold

    cache.setStaleThreshold(2000); // now 2s threshold
    expect(cache.isStale()).toBe(true); // 3s > 2s
    jest.useRealTimers();
  });

  test('successive set() calls overwrite previous data', () => {
    cache.set({ version: 1 });
    cache.set({ version: 2 });
    expect(cache.get().version).toBe(2);
  });
});
