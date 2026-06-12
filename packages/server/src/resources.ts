import {
  ArtifactAccessDeniedError,
  InvalidResourceUriError,
} from '@reaatech/media-pipeline-mcp-core';
import type { ArtifactStore, StorageResult } from '@reaatech/media-pipeline-mcp-storage';
import { getTenantId } from './tenant-context.js';

export type ResourceScope = 'session' | 'tenant' | 'global';

export interface ArtifactResourceConfig {
  enabled: boolean;
  defaultScope?: ResourceScope;
  /** Artifacts above this size return a signed-URL reference rather than inline bytes. Default 8 MB. */
  inlineMaxBytes?: number;
  sessionRetentionMs?: number;
  /** Signed-URL TTL when returning a reference. Default 15 minutes. */
  signedUrlTtlSeconds?: number;
}

export type ReadResourceResult =
  | { kind: 'inline'; data: Buffer; mimeType: string; size: number }
  | { kind: 'reference'; signedUrl: string; mimeType: string; size: number };

const DEFAULT_INLINE_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_SIGNED_URL_TTL_SECONDS = 15 * 60;

export interface ArtifactResource {
  uri: string;
  name: string;
  description?: string;
  mimeType: string;
  size: number;
  createdAt: string;
  metadata: {
    runId: string;
    stepId: string;
    provider: string;
    model: string;
    tags: string[];
  };
}

interface StoredArtifactResource {
  resource: ArtifactResource;
  expiresAtMs?: number;
}

export class ArtifactResourceHandler {
  private resources: Map<string, StoredArtifactResource> = new Map();
  private subscribers: Set<() => void> = new Set();

  constructor(
    private config: ArtifactResourceConfig,
    private storage: ArtifactStore,
    private tenantId?: string,
  ) {}

  async addResource(
    artifactId: string,
    runId: string,
    stepId: string,
    provider: string,
    model: string,
    tags: string[] = [],
  ): Promise<void> {
    let artifact: StorageResult;
    try {
      artifact = await this.storage.get(artifactId);
    } catch {
      return;
    }

    const scope = this.config.defaultScope ?? 'session';
    const prefix = scope === 'tenant' && this.tenantId ? `tenant/${this.tenantId}` : scope;
    const uri = `artifact://${prefix}/${artifactId}`;
    const expiresAtMs =
      scope === 'session' && this.config.sessionRetentionMs !== undefined
        ? Date.now() + this.config.sessionRetentionMs
        : undefined;

    this.resources.set(uri, {
      expiresAtMs,
      resource: {
        uri,
        name: artifactId,
        description: `Artifact from ${stepId} (${provider}/${model})`,
        mimeType: artifact.meta.mimeType,
        size:
          typeof artifact.data === 'object' && artifact.data !== null && 'length' in artifact.data
            ? (artifact.data as Buffer).length
            : 0,
        createdAt: new Date().toISOString(),
        metadata: { runId, stepId, provider, model, tags },
      },
    });

    this.notifySubscribers();
  }

  async listResources(): Promise<ArtifactResource[]> {
    this.pruneExpiredResources();
    return Array.from(this.resources.values(), (entry) => entry.resource);
  }

  async readResource(uri: string): Promise<ReadResourceResult | null> {
    const scope = this.parseUriScope(uri);
    if (!scope) {
      throw this.createInvalidUriError(uri);
    }
    this.pruneExpiredResources();

    // Tenant-scope cross-check: a handler bound to tenant A cannot serve tenant B's URIs.
    // Session/global handlers are not tenant-scoped. When the handler wasn't constructed
    // with a fixed tenantId, fall back to the AsyncLocalStorage tenant context so the
    // same shared handler instance still enforces per-request tenant boundaries (F18).
    if (scope.kind === 'tenant') {
      const activeTenantId = this.tenantId ?? getTenantId();
      if (!activeTenantId || scope.tenantId !== activeTenantId) {
        throw new ArtifactAccessDeniedError();
      }
    }

    // The URI must have been registered via addResource — bare-string URIs that match
    // a scope pattern but were not added are rejected (otherwise any storage key under
    // the prefix would be readable).
    if (!this.resources.has(uri)) return null;

    let artifact: StorageResult;
    try {
      artifact = await this.storage.get(scope.artifactId);
    } catch {
      return null;
    }

    const buf =
      artifact.data instanceof Buffer ? artifact.data : Buffer.from(JSON.stringify(artifact.data));
    const mimeType = artifact.meta.mimeType;
    const size = buf.length;
    const inlineMax = this.config.inlineMaxBytes ?? DEFAULT_INLINE_MAX_BYTES;

    if (size <= inlineMax) {
      return { kind: 'inline', data: buf, mimeType, size };
    }

    // Above the inline cap: return a short-lived signed URL instead of bytes.
    const ttl = this.config.signedUrlTtlSeconds ?? DEFAULT_SIGNED_URL_TTL_SECONDS;
    const signedUrl = await this.storage.getSignedUrl(scope.artifactId, ttl);
    return { kind: 'reference', signedUrl, mimeType, size };
  }

  pruneExpiredResources(nowMs: number = Date.now()): void {
    for (const [uri, entry] of this.resources.entries()) {
      if (entry.expiresAtMs !== undefined && entry.expiresAtMs <= nowMs) {
        this.resources.delete(uri);
      }
    }
  }

  private createInvalidUriError(uri: string): Error & { code: string; retryable: boolean } {
    if (typeof InvalidResourceUriError === 'function') {
      return new InvalidResourceUriError(uri);
    }
    return Object.assign(new Error(`Invalid resource URI: ${uri}`), {
      code: 'INVALID_RESOURCE_URI',
      retryable: false,
    });
  }

  /** Parse `artifact://<scope>/...` into a typed scope descriptor. */
  private parseUriScope(
    uri: string,
  ):
    | { kind: 'session' | 'global'; artifactId: string }
    | { kind: 'tenant'; tenantId: string; artifactId: string }
    | null {
    if (!uri.startsWith('artifact://')) return null;
    const rest = uri.slice('artifact://'.length);
    const parts = rest.split('/');
    if (parts.length < 2) return null;

    const [head, ...tail] = parts;
    if (head === 'session' || head === 'global') {
      if (tail.length !== 1) return null;
      return { kind: head, artifactId: tail[0] };
    }
    if (head === 'tenant') {
      if (tail.length !== 2) return null;
      const [tenantId, artifactId] = tail;
      return { kind: 'tenant', tenantId, artifactId };
    }
    return null;
  }

  onUpdate(cb: () => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  private notifySubscribers(): void {
    for (const cb of this.subscribers) cb();
  }
}
