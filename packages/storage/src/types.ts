import type { ArtifactType } from '@reaatech/media-pipeline-mcp';

export interface ArtifactMeta {
  id: string;
  type: ArtifactType;
  mimeType: string;
  size?: number;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  sourceStep?: string;
}

export interface StorageResult {
  data: Buffer | NodeJS.ReadableStream | unknown;
  meta: ArtifactMeta;
}

export interface ArtifactStore {
  /**
   * Store an artifact and return its URI
   * @param data - Buffer or stream data
   */
  put(
    id: string,
    data: Buffer | NodeJS.ReadableStream | unknown,
    meta: ArtifactMeta,
  ): Promise<string>;

  /**
   * Retrieve an artifact by ID
   */
  get(id: string): Promise<StorageResult>;

  /**
   * Get a signed URL for direct access to the artifact
   */
  getSignedUrl(id: string, expiresIn?: number): Promise<string>;

  /**
   * Delete an artifact
   */
  delete(id: string): Promise<void>;

  /**
   * List artifacts with optional prefix filter
   */
  list(prefix?: string): Promise<ArtifactMeta[]>;

  /**
   * Check if the storage backend is available
   */
  healthCheck(): Promise<boolean>;
}

export interface LocalStorageConfig {
  basePath: string;
  ttl?: number; // TTL in milliseconds
  serveHttp?: boolean;
  httpPort?: number;
  httpHost?: string;
}

export interface S3StorageConfig {
  bucket: string;
  region: string;
  prefix?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  endpoint?: string; // For S3-compatible services like MinIO
}

export interface GCSStorageConfig {
  bucket: string;
  prefix?: string;
  projectId?: string;
  keyFilename?: string;
}

export type StorageConfig =
  | { type: 'local'; config: LocalStorageConfig }
  | { type: 's3'; config: S3StorageConfig }
  | { type: 'gcs'; config: GCSStorageConfig };
