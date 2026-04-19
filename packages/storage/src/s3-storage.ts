import type { ArtifactStore, StorageResult, ArtifactMeta, S3StorageConfig } from './types.js';

export class S3Storage implements ArtifactStore {
  private bucket: string;
  private region: string;
  private prefix: string;
  private s3Client: unknown;
  private initialized = false;
  private config: S3StorageConfig;

  constructor(config: S3StorageConfig) {
    this.config = config;
    this.bucket = config.bucket;
    this.region = config.region;
    this.prefix = config.prefix || '';
  }

  private async getClient(): Promise<any> {
    if (!this.initialized) {
      const { S3Client } = await import('@aws-sdk/client-s3');
      const clientConfig: Record<string, unknown> = { region: this.region };
      if (this.config.accessKeyId && this.config.secretAccessKey) {
        clientConfig.credentials = {
          accessKeyId: this.config.accessKeyId,
          secretAccessKey: this.config.secretAccessKey,
        };
      }
      if (this.config.endpoint) {
        clientConfig.endpoint = this.config.endpoint;
        clientConfig.forcePathStyle = true;
      }
      this.s3Client = new S3Client(clientConfig);
      this.initialized = true;
    }
    return this.s3Client;
  }

  private getKey(id: string): string {
    if (id.includes('..') || id.includes('/') || id.includes('\\')) {
      throw new Error(`Invalid artifact ID: ${id}`);
    }
    return this.prefix ? `${this.prefix}${id}` : id;
  }

  async put(id: string, data: Buffer | ReadableStream, meta: ArtifactMeta): Promise<string> {
    const client = await this.getClient();
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');

    const key = this.getKey(id);
    const buffer = Buffer.isBuffer(data) ? data : await this.streamToBuffer(data as ReadableStream);

    await client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: meta.mimeType,
        Metadata: {
          artifactType: meta.type,
          sourceStep: meta.sourceStep || '',
          metadata: JSON.stringify(meta.metadata || {}),
        },
      })
    );

    return `s3://${this.bucket}/${key}`;
  }

  async get(id: string): Promise<StorageResult> {
    const client = await this.getClient();
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');

    const key = this.getKey(id);

    try {
      const response = await client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        })
      );

      // Reconstruct metadata from S3 object metadata
      const meta: ArtifactMeta = {
        id,
        type: (response.Metadata?.artifacttype as ArtifactMeta['type']) || 'image',
        mimeType: response.ContentType || 'application/octet-stream',
        sourceStep: response.Metadata?.sourcestep as string,
        metadata: response.Metadata?.metadata
          ? JSON.parse(response.Metadata.metadata as string)
          : undefined,
      };

      return {
        data: response.Body as Buffer | ReadableStream,
        meta,
      };
    } catch (error: any) {
      if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
        throw new Error(`Artifact not found: ${id}`, { cause: error });
      }
      throw error;
    }
  }

  async getSignedUrl(id: string, expiresIn = 3600): Promise<string> {
    const client = await this.getClient();
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');

    const key = this.getKey(id);

    // Simple signed URL generation
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');

    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    return await getSignedUrl(client, command, { expiresIn });
  }

  async delete(id: string): Promise<void> {
    const client = await this.getClient();
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');

    const key = this.getKey(id);

    await client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      })
    );
  }

  async list(prefix?: string): Promise<ArtifactMeta[]> {
    const client = await this.getClient();
    const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');

    const listPrefix = prefix ? this.getKey(prefix) : this.prefix;

    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: listPrefix,
      })
    );

    const metas: ArtifactMeta[] = [];

    for (const object of response.Contents || []) {
      const key = object.Key;
      if (!key) continue;

      const id = this.prefix ? key.substring(this.prefix.length) : key;

      // Try to extract metadata from the object if it was stored with metadata
      const storedMeta = object.Metadata?.artifacttype;
      const storedMimeType = object.Metadata?.mimetype;

      metas.push({
        id,
        type: (storedMeta as ArtifactMeta['type']) || this.guessTypeFromKey(key),
        mimeType: storedMimeType || this.guessMimeTypeFromKey(key),
      });
    }

    return metas;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const client = await this.getClient();
      const { HeadBucketCommand } = await import('@aws-sdk/client-s3');

      await client.send(
        new HeadBucketCommand({
          Bucket: this.bucket,
        })
      );

      return true;
    } catch {
      return false;
    }
  }

  private guessTypeFromKey(key: string): ArtifactMeta['type'] {
    const ext = key.toLowerCase();
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
    return 'image'; // Default fallback
  }

  private guessMimeTypeFromKey(key: string): string {
    const ext = key.toLowerCase();
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
