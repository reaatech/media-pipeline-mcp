export * from './types.js';
export * from './local-storage.js';
export * from './s3-storage.js';
export * from './gcs-storage.js';

import type { StorageConfig, ArtifactStore } from './types.js';
import { LocalStorage } from './local-storage.js';
import { S3Storage } from './s3-storage.js';
import { GCSStorage } from './gcs-storage.js';

export function createStorage(config: StorageConfig): ArtifactStore {
  switch (config.type) {
    case 'local':
      return new LocalStorage(config.config);
    case 's3':
      return new S3Storage(config.config);
    case 'gcs':
      return new GCSStorage(config.config);
    default:
      throw new Error(`Unknown storage type: ${(config as any).type}`);
  }
}
