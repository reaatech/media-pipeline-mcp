import { createHash } from 'node:crypto';
import { IdempotencyConflictError } from '@reaatech/media-pipeline-mcp-core';

// Re-export so callers continue importing from this module.
export { IdempotencyConflictError };

export interface IdempotencyEntry {
  key: string;
  runId: string;
  bodyHash: string;
  /** Stored success response (when status='completed'). */
  response?: unknown;
  /** Stored failure (when status='failed') — re-thrown on replay. */
  failure?: { code: string; message: string };
  status: 'completed' | 'in-flight' | 'failed';
  createdAt: Date;
  expiresAt: Date;
}

export interface IdempotencyStore {
  get(key: string): Promise<IdempotencyEntry | undefined>;
  set(entry: IdempotencyEntry): Promise<void>;
  delete(key: string): Promise<void>;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private store = new Map<string, IdempotencyEntry>();

  async get(key: string): Promise<IdempotencyEntry | undefined> {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < new Date()) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  async set(entry: IdempotencyEntry): Promise<void> {
    this.store.set(entry.key, entry);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  get size(): number {
    return this.store.size;
  }
}

function canonicalStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return String(value);
}

export function computeBodyHash(body: unknown): string {
  const canonical = canonicalStringify(body);
  return createHash('sha256').update(canonical).digest('hex');
}

export interface IdempotencyMiddlewareOptions {
  store: IdempotencyStore;
  ttlMs?: number;
  /** Optional generator for the real run id. If omitted, the idempotency key is reused. */
  generateRunId?: () => string;
}

export class IdempotencyMiddleware {
  private _store: IdempotencyStore;
  /** Access the underlying store for direct read/write (e.g. resume-after-replay). */
  get store(): IdempotencyStore {
    return this._store;
  }
  private ttlMs: number;
  private generateRunId: () => string;

  constructor(options: IdempotencyMiddlewareOptions) {
    this._store = options.store;
    this.ttlMs = options.ttlMs ?? 86_400_000; // 24h default
    this.generateRunId =
      options.generateRunId ??
      (() => {
        // RFC 4122 v4 fallback; callers should inject a ULID generator in production.
        return `run-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
      });
  }

  extractIdempotencyKey(args: Record<string, unknown>): string | undefined {
    const meta = args._meta as Record<string, unknown> | undefined;
    if (!meta || typeof meta !== 'object') return undefined;
    const key = meta.idempotencyKey;
    return typeof key === 'string' && key.length > 0 ? key : undefined;
  }

  extractProgressToken(args: Record<string, unknown>): string | undefined {
    const meta = args._meta as Record<string, unknown> | undefined;
    if (!meta || typeof meta !== 'object') return undefined;
    const token = meta.progressToken;
    return typeof token === 'string' && token.length > 0 ? token : undefined;
  }

  wrap<TArgs extends Record<string, unknown>, TResult>(
    handler: (args: TArgs, runId: string) => Promise<TResult>,
  ): (args: TArgs) => Promise<TResult> {
    return async (args: TArgs): Promise<TResult> => {
      const idempotencyKey = this.extractIdempotencyKey(args);
      if (!idempotencyKey) {
        return handler(args, this.generateRunId());
      }

      const bodyHash = computeBodyHash(args);
      const existing = await this.store.get(idempotencyKey);

      if (existing) {
        // Body mismatch is checked first regardless of prior status — a different body
        // with the same key is always a conflict (in-flight OR completed OR failed).
        if (existing.bodyHash !== bodyHash) {
          throw new IdempotencyConflictError('body-mismatch', existing.runId);
        }

        if (existing.status === 'in-flight') {
          throw new IdempotencyConflictError('in-flight', existing.runId);
        }

        if (existing.status === 'failed') {
          // Re-throw the stored failure so callers observe the same error twice.
          const f = existing.failure;
          if (f) {
            const err = new Error(f.message);
            (err as Error & { code?: string }).code = f.code;
            throw err;
          }
          throw new Error('Idempotency entry marked failed but no failure recorded');
        }

        return existing.response as TResult;
      }

      const runId = this.generateRunId();
      const entry: IdempotencyEntry = {
        key: idempotencyKey,
        runId,
        bodyHash,
        status: 'in-flight',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + this.ttlMs),
      };

      await this.store.set(entry);

      try {
        const result = await handler(args, runId);
        entry.status = 'completed';
        entry.response = result;
        await this.store.set(entry);
        return result;
      } catch (error) {
        entry.status = 'failed';
        entry.failure = {
          code: (error as Error & { code?: string }).code ?? 'UNKNOWN',
          message: (error as Error).message,
        };
        await this.store.set(entry);
        throw error;
      }
    };
  }
}
