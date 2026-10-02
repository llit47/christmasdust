import test from 'node:test';
import assert from 'node:assert/strict';
import { rankServers } from '../public/js/ranking.js';

const location = { latitude: 0, longitude: 0 };
const server = (id, overrides = {}) => ({ id, status: 'online', stale: false, password: false,
  players: 1, maxPlayers: 32, ...location, classification: { confidence: 'high', score: 12 }, ...overrides });
const ids = (rows, options) => rankServers(rows, options).map(row => row.id);

for (const sort of ['recommended', 'players', 'proximity']) {
  test(`${sort}: available favorites lead and keep the selected ordering within their group`, () => {
    const favorite = server('b', { players: 2, latitude: 10, classification: { confidence: 'probable', score: 1 } });
    const strongerFavorite = server('c', { players: 3, latitude: 5 });
    const nonFavorite = server('a', { players: 20 });
    assert.deepEqual(ids([nonFavorite, favorite, strongerFavorite], {
      sort, location, favoriteIds: new Set(['b', 'c'])
    }), ['c', 'b', 'a']);
  });

  test(`${sort}: unavailable favorites receive no boost`, () => {
    for (const unavailable of [{ status: 'offline' }, { stale: true }, { players: 32 }, { password: true }, { maxPlayers: 0 }]) {
      const rows = [server('b', unavailable), server('a', { players: 32 })];
      assert.deepEqual(ids(rows, { sort, location, favoriteIds: new Set(['b']) }), ids(rows, { sort, location }));
    }
  });

  test(`${sort}: endpoint ID remains the deterministic fallback`, () => {
    const rows = [server('c'), server('a', { ratings: { up: 2, down: 2 } }), server('b')];
    for (const favoriteIds of [new Set(), new Set(['a', 'b', 'c'])]) {
      assert.deepEqual(ids(rows, { sort, favoriteIds }), ['a', 'b', 'c']);
      assert.deepEqual(ids([...rows].reverse(), { sort, favoriteIds }), ['a', 'b', 'c']);
    }
  });
}

test('favorites saved under grouped endpoints receive the same priority', () => {
  assert.deepEqual(ids([server('a'), server('b', { duplicateEndpoints: ['c'] })], {
    favoriteIds: new Set(['c'])
  }), ['b', 'a']);
});

test('recommended prefers better bounded ratings before country and distance', () => {
  const rows = [server('a', { countryCode: 'GB', ratings: { up: 100, down: 100 } }),
    server('b', { latitude: 10, ratings: { up: 8, down: 1 } })];
  assert.deepEqual(ids(rows, { countryCode: 'GB', location }), ['b', 'a']);
});

test('recommended discounts tiny samples and treats missing ratings as zero', () => {
  const rows = [server('a', { ratings: { up: 1, down: 0 } }),
    server('b', { ratings: { up: 8, down: 1 } }), server('c'),
    server('d', { ratings: { up: 0, down: 1 } })];
  assert.deepEqual(ids(rows), ['b', 'a', 'c', 'd']);
});

test('one positive vote cannot overpower Christmas classification or relevance score', () => {
  const positive = { up: 1, down: 0 };
  const rows = [server('a', { classification: { confidence: 'probable', score: 100 }, ratings: positive }),
    server('b', { classification: { confidence: 'high', score: 11 }, ratings: positive }), server('c')];
  assert.deepEqual(ids(rows), ['c', 'b', 'a']);
});

for (const sort of ['players', 'proximity']) {
  test(`${sort}: ratings do not affect ordering`, () => {
    const rows = [server('a', { players: 20 }), server('b', { latitude: 10, ratings: { up: 100, down: 0 } })];
    assert.deepEqual(ids(rows, { sort, location }), ['a', 'b']);
    assert.deepEqual(ids(rows, { sort, location, favoriteIds: new Set(['a', 'b']) }), ['a', 'b']);
  });
}
