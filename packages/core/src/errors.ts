import type { SerializedError } from './types/index.js';

export class UpNextError extends Error {
  readonly code: string;
  readonly adapterId?: string;

  constructor(code: string, message: string, adapterId?: string) {
    super(message);
    this.name = 'UpNextError';
    this.code = code;
    if (adapterId !== undefined) this.adapterId = adapterId;
  }

  toJSON(): SerializedError {
    const out: SerializedError = { code: this.code, message: this.message };
    if (this.adapterId) out.adapterId = this.adapterId;
    return out;
  }
}

/** Errors cross process boundaries as data, so everything normalizes to this. */
export function toSerializedError(err: unknown, adapterId?: string): SerializedError {
  if (err instanceof UpNextError) {
    const out = err.toJSON();
    if (adapterId && !out.adapterId) out.adapterId = adapterId;
    return out;
  }
  const message = err instanceof Error ? err.message : String(err);
  const out: SerializedError = { code: 'unknown', message };
  if (adapterId) out.adapterId = adapterId;
  return out;
}

export const ErrorCodes = {
  NoAdapter: 'no_adapter',
  ResolveFailed: 'resolve_failed',
  IntentUnresolved: 'intent_unresolved',
  NoIntentResolver: 'no_intent_resolver',
  LoadFailed: 'load_failed',
  Unsupported: 'unsupported',
  NotFound: 'not_found',
  VersionConflict: 'version_conflict',
  AdapterFailed: 'adapter_failed',
  Timeout: 'timeout',
  Disposed: 'disposed',
} as const;
