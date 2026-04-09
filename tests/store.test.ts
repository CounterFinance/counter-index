import { describe, it, expect } from 'vitest';
import { defineSchema } from '../src/schema.js';
import { createStore } from '../src/store.js';

const schema = defineSchema({
  Account: { address: { type: 'string' }, balance: { type: 'bigint' } },
  Token: { symbol: { type: 'string' } },
});

describe('createStore', () => {
  it('set + get round-trips', () => {
    const store = createStore(schema);
    store.set('Account', 'a1', { address: '0xabc', balance: 100n });
    expect(store.get('Account', 'a1')).toEqual({ id: 'a1', address: '0xabc', balance: 100n });
  });

  it('get returns undefined for missing id', () => {
    const store = createStore(schema);
    expect(store.get('Account', 'missing')).toBeUndefined();
  });

  it('set overwrites existing', () => {
    const store = createStore(schema);
    store.set('Account', 'a1', { address: '0xold' });
    store.set('Account', 'a1', { address: '0xnew' });
    expect(store.get('Account', 'a1')!.address).toBe('0xnew');
  });

  it('update merges fields', () => {
    const store = createStore(schema);
    store.set('Account', 'a1', { address: '0xabc', balance: 100n });
    store.update('Account', 'a1', { balance: 200n });
    expect(store.get('Account', 'a1')).toEqual({ id: 'a1', address: '0xabc', balance: 200n });
  });

  it('update throws for missing id', () => {
    const store = createStore(schema);
    expect(() => store.update('Account', 'missing', { balance: 1n })).toThrow('not found');
  });

  it('delete removes entity', () => {
    const store = createStore(schema);
    store.set('Account', 'a1', { address: '0xabc' });
    store.delete('Account', 'a1');
    expect(store.get('Account', 'a1')).toBeUndefined();
  });

  it('delete is no-op for missing id', () => {
    const store = createStore(schema);
    expect(() => store.delete('Account', 'missing')).not.toThrow();
  });

  it('list returns all entities', () => {
    const store = createStore(schema);
    store.set('Account', 'a1', { address: '0xa' });
    store.set('Account', 'a2', { address: '0xb' });
    expect(store.list('Account')).toHaveLength(2);
  });

  it('count returns entity count', () => {
    const store = createStore(schema);
    expect(store.count('Account')).toBe(0);
    store.set('Account', 'a1', { address: '0xa' });
    expect(store.count('Account')).toBe(1);
  });

  it('find filters by predicate', () => {
    const store = createStore(schema);
    store.set('Account', 'a1', { address: '0xa', balance: 100n });
    store.set('Account', 'a2', { address: '0xb', balance: 200n });
    store.set('Account', 'a3', { address: '0xc', balance: 50n });
    const big = store.find('Account', (r) => (r.balance as bigint) >= 100n);
    expect(big).toHaveLength(2);
  });

  it('throws for unknown entity name', () => {
    const store = createStore(schema);
    expect(() => store.get('Unknown', 'x')).toThrow('Unknown entity');
    expect(() => store.set('Unknown', 'x', {})).toThrow('Unknown entity');
    expect(() => store.list('Unknown')).toThrow('Unknown entity');
  });

  it('entities are isolated between types', () => {
    const store = createStore(schema);
    store.set('Account', 'id1', { address: '0xa' });
    store.set('Token', 'id1', { symbol: 'BTC' });
    expect(store.count('Account')).toBe(1);
    expect(store.count('Token')).toBe(1);
    expect(store.get('Account', 'id1')!.address).toBe('0xa');
    expect(store.get('Token', 'id1')!.symbol).toBe('BTC');
  });
});
