/**
 * Config loading + validation (M19). A tiny, dependency-free schema validator so
 * a deployment fails fast with a CLEAR, aggregated error at startup instead of
 * crashing later on a missing RPC URL or a non-numeric block. Reads from
 * `process.env` by default (or any string map), coerces types, applies defaults,
 * and reports EVERY problem at once.
 */

export type ConfigFieldType = 'string' | 'number' | 'integer' | 'boolean' | 'url';

export interface ConfigField {
  type: ConfigFieldType;
  /** Required when there is no `default`. */
  required?: boolean;
  default?: string | number | boolean;
  /** Inclusive numeric bounds (number/integer). */
  min?: number;
  max?: number;
  /** Allowed values (string). */
  enum?: readonly string[];
  /** Env var name. Defaults to UPPER_SNAKE_CASE of the key. */
  env?: string;
  /** Shown in error messages. */
  description?: string;
}

export type ConfigSchema = Record<string, ConfigField>;

type FieldTs<F extends ConfigField> =
  F['type'] extends 'boolean' ? boolean :
  F['type'] extends 'string' | 'url' ? string :
  number;

export type ConfigOf<S extends ConfigSchema> = { [K in keyof S]: FieldTs<S[K]> };

/** Thrown when config validation fails; `problems` lists every issue. */
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

function toEnvName(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-\s]+/g, '_').toUpperCase();
}

/** Validate + coerce config from env (or any string source). Throws ConfigError. */
export function loadConfig<S extends ConfigSchema>(
  schema: S,
  source: Record<string, string | undefined> = process.env,
): ConfigOf<S> {
  const out: Record<string, unknown> = {};
  const problems: string[] = [];

  for (const [key, field] of Object.entries(schema)) {
    const envName = field.env ?? toEnvName(key);
    const raw = source[envName];
    const label = field.description ? `${envName} (${field.description})` : envName;

    if (raw === undefined || raw === '') {
      if (field.default !== undefined) { out[key] = field.default; continue; }
      if (field.required) { problems.push(`${label} is required but not set`); continue; }
      out[key] = undefined;
      continue;
    }

    switch (field.type) {
      case 'string': {
        if (field.enum && !field.enum.includes(raw)) {
          problems.push(`${label} must be one of [${field.enum.join(', ')}], got "${raw}"`);
        } else out[key] = raw;
        break;
      }
      case 'url': {
        try { new URL(raw); out[key] = raw; }
        catch { problems.push(`${label} must be a valid URL, got "${raw}"`); }
        break;
      }
      case 'boolean': {
        const t = raw.toLowerCase();
        if (['true', '1', 'yes', 'on'].includes(t)) out[key] = true;
        else if (['false', '0', 'no', 'off'].includes(t)) out[key] = false;
        else problems.push(`${label} must be a boolean (true/false), got "${raw}"`);
        break;
      }
      case 'number':
      case 'integer': {
        const n = Number(raw);
        if (Number.isNaN(n)) { problems.push(`${label} must be a number, got "${raw}"`); break; }
        if (field.type === 'integer' && !Number.isInteger(n)) { problems.push(`${label} must be an integer, got "${raw}"`); break; }
        if (field.min !== undefined && n < field.min) { problems.push(`${label} must be >= ${field.min}, got ${n}`); break; }
        if (field.max !== undefined && n > field.max) { problems.push(`${label} must be <= ${field.max}, got ${n}`); break; }
        out[key] = n;
        break;
      }
    }
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return out as ConfigOf<S>;
}
