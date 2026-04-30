import type { ArtifactMeta, ArtifactStore, GCSStorageConfig, StorageResult } from './types.js';

export class GCSStorage implements ArtifactStore {
  private bucket: string;
  private prefix: string;
  private storage: unknown;
  private initialized = false;
  private config: GCSStorageConfig;

  constructor(config: GCSStorageConfig) {
    this.config = config;
    this.bucket = config.bucket;
    this.prefix = config.prefix || '';
  }

  private async getClient(): Promise<any> {
    if (!this.initialized) {
      const { Storage } = await import('@google-cloud/storage');
      const storageOptions: Record<string, unknown> = {};
      if (this.config.projectId) storageOptions.projectId = this.config.projectId;
      if (this.config.keyFilename) storageOptions.keyFilename = this.config.keyFilename;
      this.storage = new Storage(storageOptions);
      this.initialized = true;
    }
    return this.storage;
  }

  private getName(id: string): string {
    if (id.includes('..') || id.includes('/') || id.includes('\\')) {
      throw new Error(`Invalid artifact ID: ${id}`);
    }
    return this.prefix ? `${this.prefix}${id}` : id;
  }

  async put(id: string, data: Buffer | ReadableStream, meta: ArtifactMeta): Promise<string> {
    const storage = await this.getClient();
    const bucket = storage.bucket(this.bucket);
    const file = bucket.file(this.getName(id));

    const buffer = Buffer.isBuffer(data) ? data : await this.streamToBuffer(data as ReadableStream);

    await file.save(buffer, {
      metadata: {
        contentType: meta.mimeType,
        metadata: {
          artifactType: meta.type,
          sourceStep: meta.sourceStep || '',
          artifactMetadata: JSON.stringify(meta.metadata || {}),
        },
      },
    });

    return `gs://${this.bucket}/${this.getName(id)}`;
  }

  async get(id: string): Promise<StorageResult> {
    const storage = await this.getClient();
    const bucket = storage.bucket(this.bucket);
    const file = bucket.file(this.getName(id));

    try {
      const [exists] = await file.exists();
      if (!exists) {
        throw new Error(`Artifact not found: ${id}`);
      }

      const [metadata] = await file.getMetadata();
      const artifactMeta: ArtifactMeta = {
        id,
        type: (metadata.metadata?.artifacttype as ArtifactMeta['type']) || 'image',
        mimeType: metadata.contentType || 'application/octet-stream',
        sourceStep: metadata.metadata?.sourcestep as string,
        metadata: metadata.metadata?.artifactmetadata
          ? JSON.parse(metadata.metadata.artifactmetadata as string)
          : undefined,
      };

      // Return a readable stream
      const data = file.createReadStream();

      return { data, meta: artifactMeta };
    } catch (error: any) {
      if (error.code === 404) {
        throw new Error(`Artifact not found: ${id}`, { cause: error });
      }
      throw error;
    }
  }

  async getSignedUrl(id: string, expiresIn = 3600): Promise<string> {
    const storage = await this.getClient();
    const bucket = storage.bucket(this.bucket);
    const file = bucket.file(this.getName(id));

    try {
      const [url] = await file.getSignedUrl({
        action: 'read',
        expires: Date.now() + expiresIn * 1000,
      });

      return url;
    } catch (error: any) {
      if (error.code === 404) {
        throw new Error(`Artifact not found: ${id}`, { cause: error });
      }
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    const storage = await this.getClient();
    const bucket = storage.bucket(this.bucket);
    const file = bucket.file(this.getName(id));

    try {
      await file.delete();
    } catch (error: any) {
      if (error.code !== 404) {
        throw error;
      }
    }
  }

  async list(prefix?: string): Promise<ArtifactMeta[]> {
    const storage = await this.getClient();
    const bucket = storage.bucket(this.bucket);

    const listPrefix = prefix ? this.getName(prefix) : this.prefix;

    const [files] = await bucket.getFiles({
      prefix: listPrefix,
    });

    const metas: ArtifactMeta[] = [];

    for (const file of files) {
      const name = file.name;
      if (!name) continue;

      const id = this.prefix ? name.substring(this.prefix.length) : name;

      const metadata = file.metadata;
      metas.push({
        id,
        type:
          (metadata.metadata?.artifacttype as ArtifactMeta['type']) || this.guessTypeFromName(name),
        mimeType: metadata.contentType || this.guessMimeTypeFromName(name),
        size: Number(metadata.size),
        sourceStep: metadata.metadata?.sourcestep as string,
      });
    }

    return metas;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const storage = await this.getClient();
      const bucket = storage.bucket(this.bucket);

      // Check if bucket is accessible
      const [exists] = await bucket.exists();
      return exists;
    } catch {
      return false;
    }
  }

  private guessTypeFromName(name: string): ArtifactMeta['type'] {
    const ext = name.toLowerCase();
    if (
      ext.endsWith('.png') ||
      ext.endsWith('.jpg') ||
      ext.endsWith('.jpeg') ||
      ext.endsWith('.gif') ||
      ext.endsWith('.webp') ||
      ext.endsWith('.bmp')
    ) {
      return 'image';
    }
    if (
      ext.endsWith('.mp4') ||
      ext.endsWith('.webm') ||
      ext.endsWith('.mov') ||
      ext.endsWith('.avi')
    ) {
      return 'video';
    }
    if (
      ext.endsWith('.mp3') ||
      ext.endsWith('.wav') ||
      ext.endsWith('.ogg') ||
      ext.endsWith('.flac')
    ) {
      return 'audio';
    }
    if (
      ext.endsWith('.pdf') ||
      ext.endsWith('.doc') ||
      ext.endsWith('.docx') ||
      ext.endsWith('.txt')
    ) {
      return 'document';
    }
    return 'image';
  }

  private guessMimeTypeFromName(name: string): string {
    const ext = name.toLowerCase();
    if (ext.endsWith('.png')) return 'image/png';
    if (ext.endsWith('.jpg') || ext.endsWith('.jpeg')) return 'image/jpeg';
    if (ext.endsWith('.gif')) return 'image/gif';
    if (ext.endsWith('.webp')) return 'image/webp';
    if (ext.endsWith('.mp4')) return 'video/mp4';
    if (ext.endsWith('.webm')) return 'video/webm';
    if (ext.endsWith('.mp3')) return 'audio/mpeg';
    if (ext.endsWith('.wav')) return 'audio/wav';
    if (ext.endsWith('.pdf')) return 'application/pdf';
    return 'application/octet-stream';
  }

  private async streamToBuffer(stream: ReadableStream): Promise<Buffer> {
    const chunks: Uint8Array[] = [];

    const nodeStream = stream as unknown as NodeJS.ReadableStream;
    for await (const chunk of nodeStream) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }

    return Buffer.concat(chunks);
  }
}
