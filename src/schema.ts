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
  /** List entity names. */
  entityNames(): string[];
  /** Get field definitions for an entity. Throws if unknown. */
  getEntity(name: string): EntityDef;
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
export function defineSchema<S extends SchemaDefinition>(def: S): Schema<S> {
  validateSchema(def);

  return {
    entities: def,
    entityNames() {
      return Object.keys(def);
    },
    getEntity(name: string): EntityDef {
      const entity = def[name];
      if (!entity) throw new Error(`Unknown entity: "${name}"`);
      return entity;
    },
  };
}
