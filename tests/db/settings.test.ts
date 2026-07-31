/**
 * Settings repository unit tests.
 */

import { describe, expect, it } from 'vitest';

import { useMockedDb } from '../helpers/mock-db';

import { del, get, getAll, set } from '@/main/db/repositories/settings';

describe('settings repository', () => {
  useMockedDb();

  describe('get/set round trip', () => {
    it('returns null for a missing key', () => {
      expect(get('missing')).toBeNull();
    });

    it('stores and retrieves a string value', () => {
      set('user_name', 'jack');
      expect(get<string>('user_name')).toBe('jack');
    });

    it('stores and retrieves a number value', () => {
      set('count', 42);
      expect(get<number>('count')).toBe(42);
    });

    it('stores and retrieves a boolean', () => {
      set('agent_weekends', true);
      expect(get<boolean>('agent_weekends')).toBe(true);
    });

    it('stores and retrieves a nested object', () => {
      const obj = {
        google: { client_id: 'x', client_secret: 'y' },
        flags: { use_cache: true, retries: 3 },
      };
      set('credentials', obj);
      expect(get('credentials')).toEqual(obj);
    });

    it('stores and retrieves arrays', () => {
      const list = ['a', 'b', 'c'];
      set('tags', list);
      expect(get<string[]>('tags')).toEqual(list);
    });

    it('overwrites an existing key', () => {
      set('key', 'first');
      set('key', 'second');
      expect(get<string>('key')).toBe('second');
    });

    it('returns null when value is explicitly nulled via set', () => {
      set('temp', 'something');
      set('temp', null);
      expect(get('temp')).toBeNull();
    });
  });

  describe('del', () => {
    it('removes a key and returns true', () => {
      set('toDel', 'bye');
      expect(del('toDel')).toBe(true);
      expect(get('toDel')).toBeNull();
    });

    it('returns false for a missing key', () => {
      expect(del('not-there')).toBe(false);
    });
  });

  describe('getAll', () => {
    it('returns every setting parsed', () => {
      set('a', 'hello');
      set('b', 99);
      set('c', { nested: true });

      const all = getAll();
      expect(all['a']).toBe('hello');
      expect(all['b']).toBe(99);
      expect(all['c']).toEqual({ nested: true });
    });

    it('returns an empty object when no settings are set', () => {
      expect(getAll()).toEqual({});
    });
  });
});
