/**
 * Schema definition DSL.
 *
 * Define your indexed entities as plain objects mapping field names to types.
 * The schema drives store validation and gives you type-safe handler contexts.
 *
 * Usage:
 *   const schema = defineSchema({
 *     Account: {
 *       address: { type: 'string' },
 *       balance: { type: 'bigint' },
 *       txCount: { type: 'int' },
 *     },
 *   });
 */

// ---------------------------------------------------------------------------
// Field types
// ---------------------------------------------------------------------------

export type FieldType = 'string' | 'int' | 'float' | 'bigint' | 'boolean' | 'bytes';

export interface FieldDef {
  type: FieldType;
  optional?: boolean;
  /** Create a secondary index on this column (speeds up where/orderBy on it). */
  index?: boolean;
}

// ---------------------------------------------------------------------------
// Schema types
// ---------------------------------------------------------------------------

/** Map of field name → field definition for one entity. */
export type EntityDef = Record<string, FieldDef>;

/** Map of entity name → entity definition. */
export type SchemaDefinition = Record<string, EntityDef>;

/**
 * Validated, frozen schema object. Passed to createIndexer().
 */
export interface Schema<S extends SchemaDefinition = SchemaDefinition> {
  readonly entities: S;
  /** True when this schema indexes multiple chains (adds a `chainId` dimension). */
  readonly multichain: boolean;
  /** List entity names. */
  entityNames(): string[];
  /** Get field definitions for an entity. Throws if unknown. */
  getEntity(name: string): EntityDef;
}

export interface DefineSchemaOptions {
  /**
   * Index multiple chains into one schema. Each entity gains a `chainId` column,
   * entity ids are namespaced per chain, and GraphQL exposes `chainId` as a
   * filterable field. Use with `createMultiIndexer`.
   */
  multichain?: boolean;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_FIELD_TYPES = new Set<FieldType>([
  'string', 'int', 'float', 'bigint', 'boolean', 'bytes',
]);

function validateSchema(def: SchemaDefinition): void {
  const names = Object.keys(def);
  if (names.length === 0) throw new Error('Schema must define at least one entity');

  for (const entityName of names) {
    const fields = def[entityName];
    const fieldNames = Object.keys(fields);
    if (fieldNames.length === 0) {
      throw new Error(`Entity "${entityName}" must have at least one field`);
    }
    for (const fieldName of fieldNames) {
      const field = fields[fieldName];
      if (!VALID_FIELD_TYPES.has(field.type)) {
        throw new Error(
          `Entity "${entityName}" field "${fieldName}": unknown type "${field.type}"`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Define and validate an indexer schema.
 *
 * ```ts
 * const schema = defineSchema({
 *   Account: {
 *     address: { type: 'string' },
 *     balance: { type: 'bigint' },
 *     txCount: { type: 'int' },
 *   },
 * });
 * ```
 */
export function defineSchema<const S extends SchemaDefinition>(
  def: S,
  options?: DefineSchemaOptions,
): Schema<S> {
  validateSchema(def);
  const multichain = options?.multichain ?? false;

  // In multichain mode each entity gets an implicit `chainId` column. The
  // compile-time type stays `S` (handlers never set chainId — the scoped store
  // stamps it), but the runtime entities carry the extra field so the store
  // persists it and GraphQL exposes it as a filter.
  const entities = (multichain ? augmentMultichain(def) : def) as S;

  return {
    entities,
    multichain,
    entityNames() {
      return Object.keys(entities);
    },
    getEntity(name: string): EntityDef {
      const entity = entities[name];
      if (!entity) throw new Error(`Unknown entity: "${name}"`);
      return entity;
    },
  };
}

/** Prepend a `chainId` int field to every entity (multichain mode). */
function augmentMultichain(def: SchemaDefinition): SchemaDefinition {
  const out: SchemaDefinition = {};
  for (const [name, fields] of Object.entries(def)) {
    out[name] = { chainId: { type: 'int' }, ...fields };
  }
  return out;
}
