import { describe, it, expect } from 'vitest';
import { defineSchema } from '../src/schema.js';

describe('defineSchema', () => {
  it('creates a schema with entity names', () => {
    const schema = defineSchema({
      Account: { address: { type: 'string' }, balance: { type: 'bigint' } },
      Token: { symbol: { type: 'string' }, decimals: { type: 'int' } },
    });
    expect(schema.entityNames()).toEqual(['Account', 'Token']);
  });

  it('getEntity returns field definitions', () => {
    const schema = defineSchema({
      Account: { address: { type: 'string' }, active: { type: 'boolean' } },
    });
    const entity = schema.getEntity('Account');
    expect(entity.address.type).toBe('string');
    expect(entity.active.type).toBe('boolean');
  });

  it('getEntity throws for unknown entity', () => {
    const schema = defineSchema({ Account: { address: { type: 'string' } } });
    expect(() => schema.getEntity('Missing')).toThrow('Unknown entity: "Missing"');
  });

  it('throws on empty schema', () => {
    expect(() => defineSchema({})).toThrow('at least one entity');
  });

  it('throws on entity with no fields', () => {
    expect(() => defineSchema({ Empty: {} })).toThrow('at least one field');
  });

  it('throws on invalid field type', () => {
    expect(() =>
      defineSchema({ Bad: { x: { type: 'invalid' as 'string' } } }),
    ).toThrow('unknown type');
  });

  it('supports all field types', () => {
    const schema = defineSchema({
      All: {
        s: { type: 'string' },
        i: { type: 'int' },
        f: { type: 'float' },
        b: { type: 'bigint' },
        bool: { type: 'boolean' },
        raw: { type: 'bytes' },
      },
    });
    expect(Object.keys(schema.getEntity('All'))).toHaveLength(6);
  });
});
