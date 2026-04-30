import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ArtifactMeta, ArtifactStore, LocalStorageConfig, StorageResult } from './types.js';

export class LocalStorage implements ArtifactStore {
  private basePath: string;
  private ttl?: number;
  private cleanupInterval?: NodeJS.Timeout;

  constructor(config: LocalStorageConfig) {
    this.basePath = config.basePath;
    this.ttl = config.ttl;

    // Ensure base directory exists
    this.ensureDirectory();

    // Start TTL cleanup if configured
    if (this.ttl) {
      this.startCleanupInterval();
    }
  }

  private ensureDirectory(): void {
    fs.mkdir(this.basePath, { recursive: true }).catch(console.error);
  }

  private startCleanupInterval(): void {
    // Run cleanup every hour
    this.cleanupInterval = setInterval(() => this.cleanup(), 60 * 60 * 1000);
  }

  private async cleanup(): Promise<void> {
    if (!this.ttl) return;

    try {
      const files = await fs.readdir(this.basePath);
      const now = Date.now();

      for (const file of files) {
        const filePath = join(this.basePath, file);
        const stat = await fs.stat(filePath);
        const age = now - stat.mtimeMs;

        if (age > this.ttl) {
          await fs.unlink(filePath).catch(console.error);
        }
      }
    } catch (error) {
      console.error('Storage cleanup failed:', error);
    }
  }

  private getFilePath(id: string): string {
    // Validate ID to prevent path traversal attacks
    if (id.includes('..') || id.includes('/') || id.includes('\\') || id.startsWith('/')) {
      throw new Error(`Invalid artifact ID: ${id}`);
    }
    return join(this.basePath, id);
  }

  async put(id: string, data: Buffer | NodeJS.ReadableStream, meta: ArtifactMeta): Promise<string> {
    const filePath = this.getFilePath(id);
    const extension = this.getExtension(meta.mimeType);

    // Rename file to include extension
    const filePathWithExt = `${filePath}${extension}`;

    // Ensure parent directory exists
    await fs.mkdir(dirname(filePathWithExt), { recursive: true });

    if (Buffer.isBuffer(data)) {
      await fs.writeFile(filePathWithExt, data);
    } else {
      // Handle ReadableStream
      const stream = data as NodeJS.ReadableStream;
      const writeStream = createWriteStream(filePathWithExt);

      await new Promise<void>((resolve, reject) => {
        stream.pipe(writeStream);
        stream.on('end', resolve);
        stream.on('error', reject);
      });
    }

    // Store metadata
    const metaPath = `${filePathWithExt}.meta.json`;
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));

    return `file://${filePathWithExt}`;
  }

  async get(id: string): Promise<StorageResult> {
    // Find file with any extension
    const dirFiles = await fs.readdir(this.basePath);
    const file = dirFiles.find((f) => f === id || f.startsWith(`${id}.`));

    if (!file) {
      throw new Error(`Artifact not found: ${id}`);
    }

    const filePath = join(this.basePath, file);
    const metaPath = `${filePath}.meta.json`;

    // Read metadata
    let meta: ArtifactMeta | undefined;
    try {
      const metaContent = await fs.readFile(metaPath, 'utf-8');
      meta = JSON.parse(metaContent);
    } catch {
      // Metadata not found, create basic meta from file
      const stat = await fs.stat(filePath);
      meta = {
        id,
        type: 'image',
        mimeType: 'application/octet-stream',
        size: stat.size,
      };
    }

    const data = createReadStream(filePath);

    return { data, meta: meta! };
  }

  async getSignedUrl(id: string, expiresIn = 3600): Promise<string> {
    // For local storage, just return the file URI
    // In a real implementation, this could start a temporary HTTP server
    const dirFiles = await fs.readdir(this.basePath);
    const file = dirFiles.find((f) => f === id || f.startsWith(`${id}.`));

    if (!file) {
      throw new Error(`Artifact not found: ${id}`);
    }

    return `file://${join(this.basePath, file)}?expires=${Date.now() + expiresIn * 1000}`;
  }

  async delete(id: string): Promise<void> {
    try {
      const dirFiles = await fs.readdir(this.basePath);
      const files = dirFiles.filter((f) => f === id || f.startsWith(`${id}.`));

      for (const file of files) {
        const filePath = join(this.basePath, file);
        await fs.unlink(filePath).catch(() => {});
      }
    } catch (error) {
      // If directory doesn't exist, nothing to delete
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
  }

  async list(prefix?: string): Promise<ArtifactMeta[]> {
    if (prefix !== undefined) {
      if (
        prefix.includes('..') ||
        prefix.includes('/') ||
        prefix.includes('\\') ||
        prefix.startsWith('/')
      ) {
        throw new Error(`Invalid prefix: ${prefix}`);
      }
    }

    const dirFiles = await fs.readdir(this.basePath);
    const metas: ArtifactMeta[] = [];

    for (const file of dirFiles) {
      if (prefix && !file.startsWith(prefix)) continue;

      // Only process .meta.json files
      if (!file.endsWith('.meta.json')) continue;

      const metaPath = join(this.basePath, file);
      try {
        const content = await fs.readFile(metaPath, 'utf-8');
        const meta = JSON.parse(content);
        metas.push(meta);
      } catch {
        // Skip invalid metadata files
      }
    }

    return metas;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await fs.access(this.basePath);
      return true;
    } catch {
      return false;
    }
  }

  private getExtension(mimeType: string): string {
    const map: Record<string, string> = {
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/webp': '.webp',
      'image/gif': '.gif',
      'audio/mpeg': '.mp3',
      'audio/wav': '.wav',
      'audio/ogg': '.ogg',
      'video/mp4': '.mp4',
      'video/webm': '.webm',
      'text/plain': '.txt',
      'application/json': '.json',
      'application/pdf': '.pdf',
    };

    return map[mimeType] || '.bin';
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}
