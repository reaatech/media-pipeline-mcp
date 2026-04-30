import type { Readable } from 'node:stream';
import type { ArtifactRegistry } from '@reaatech/media-pipeline-mcp';
import type { Artifact } from '@reaatech/media-pipeline-mcp';
import type { MediaProvider, ProviderInput } from '@reaatech/media-pipeline-mcp-provider-core';
import type { ArtifactMeta, ArtifactStore } from '@reaatech/media-pipeline-mcp-storage';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';

export interface ResizeConfig {
  width?: number;
  height?: number;
  fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside';
  position?: sharp.Gravity | number[];
  background?: string;
}

export interface CropConfig {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CompositeConfig {
  top?: number;
  left?: number;
  blend?: sharp.Blend;
  gravity?: sharp.Gravity;
  opacity?: number;
}

export interface UpscaleConfig {
  artifactId: string;
  scale?: 2 | 4;
  model?: string;
  provider?: string;
}

export interface RemoveBackgroundConfig {
  artifactId: string;
  provider?: string;
}

export interface InpaintConfig {
  artifactId: string;
  maskArtifactId?: string;
  prompt: string;
  provider?: string;
}

export interface DescribeConfig {
  artifactId: string;
  detail?: 'brief' | 'detailed' | 'structured';
  provider?: string;
}

export class ImageEditOperations {
  private providers: Map<string, MediaProvider> = new Map();

  constructor(
    private artifactRegistry: ArtifactRegistry,
    private storage: ArtifactStore,
  ) {}

  /**
   * Register a provider for use with operations
   */
  registerProvider(name: string, provider: MediaProvider): void {
    this.providers.set(name, provider);
  }

  /**
   * Get a provider by name, or the first one that supports the operation
   */
  private getProvider(operation: string, preferred?: string): MediaProvider | undefined {
    if (preferred && this.providers.has(preferred)) {
      const provider = this.providers.get(preferred);
      if (provider?.supportedOperations.includes(operation)) {
        return provider;
      }
    }

    for (const provider of this.providers.values()) {
      if (provider.supportedOperations.includes(operation)) {
        return provider;
      }
    }
    return undefined;
  }

  async resize(artifactId: string, config: ResizeConfig): Promise<Artifact> {
    const artifact = this.artifactRegistry.get(artifactId);
    if (!artifact || artifact.type !== 'image') {
      throw new Error(`Artifact ${artifactId} is not an image`);
    }

    const storageResult = await this.storage.get(artifactId);
    const buffer = await this.streamToBuffer(storageResult.data as Readable);

    const image = sharp(buffer);
    const metadata = await image.metadata();

    let targetWidth = config.width || metadata.width!;
    let targetHeight = config.height || metadata.height!;

    // If only one dimension provided, calculate the other maintaining aspect ratio
    if (!config.width && config.height && metadata.width && metadata.height) {
      const ratio = config.height / metadata.height;
      targetWidth = Math.round(metadata.width * ratio);
    } else if (config.width && !config.height && metadata.width && metadata.height) {
      const ratio = config.width / metadata.width;
      targetHeight = Math.round(metadata.height * ratio);
    }

    const resizeOptions: sharp.ResizeOptions = {
      fit: config.fit || 'cover',
    };

    if (config.position) {
      resizeOptions.position = config.position as any;
    }

    const resized = image.resize(targetWidth, targetHeight, resizeOptions);

    const outputBuffer = await resized.png().toBuffer();
    const newId = `artifact-${uuidv4()}`;

    const meta: ArtifactMeta = {
      id: newId,
      type: 'image',
      mimeType: 'image/png',
      size: outputBuffer.length,
      sourceArtifact: artifactId,
      operation: 'resize',
      originalWidth: metadata.width,
      originalHeight: metadata.height,
      width: targetWidth,
      height: targetHeight,
    } as ArtifactMeta;

    const uri = await this.storage.put(newId, outputBuffer, meta);

    const newArtifact: Artifact = {
      id: newId,
      type: 'image',
      uri,
      mimeType: 'image/png',
      metadata: {
        width: targetWidth,
        height: targetHeight,
        sourceArtifact: artifactId,
        operation: 'resize',
        originalWidth: metadata.width,
        originalHeight: metadata.height,
      },
      sourceStep: artifact.sourceStep,
    };

    this.artifactRegistry.register(newArtifact);
    return newArtifact;
  }

  async crop(artifactId: string, config: CropConfig): Promise<Artifact> {
    const artifact = this.artifactRegistry.get(artifactId);
    if (!artifact || artifact.type !== 'image') {
      throw new Error(`Artifact ${artifactId} is not an image`);
    }

    const storageResult = await this.storage.get(artifactId);
    const buffer = await this.streamToBuffer(storageResult.data as Readable);

    const outputBuffer = await sharp(buffer)
      .extract({
        left: config.x,
        top: config.y,
        width: config.width,
        height: config.height,
      })
      .png()
      .toBuffer();

    const newId = `artifact-${uuidv4()}`;

    const meta: ArtifactMeta = {
      id: newId,
      type: 'image',
      mimeType: 'image/png',
      size: outputBuffer.length,
      sourceArtifact: artifactId,
      operation: 'crop',
      cropX: config.x,
      cropY: config.y,
      width: config.width,
      height: config.height,
    } as ArtifactMeta;

    const uri = await this.storage.put(newId, outputBuffer, meta);

    const newArtifact: Artifact = {
      id: newId,
      type: 'image',
      uri,
      mimeType: 'image/png',
      metadata: {
        width: config.width,
        height: config.height,
        sourceArtifact: artifactId,
        operation: 'crop',
        cropX: config.x,
        cropY: config.y,
      },
      sourceStep: artifact.sourceStep,
    };

    this.artifactRegistry.register(newArtifact);
    return newArtifact;
  }

  async composite(
    baseArtifactId: string,
    overlayArtifactId: string,
    config: CompositeConfig,
  ): Promise<Artifact> {
    const baseArtifact = this.artifactRegistry.get(baseArtifactId);
    const overlayArtifact = this.artifactRegistry.get(overlayArtifactId);

    if (!baseArtifact || baseArtifact.type !== 'image') {
      throw new Error(`Base artifact ${baseArtifactId} is not an image`);
    }
    if (!overlayArtifact || overlayArtifact.type !== 'image') {
      throw new Error(`Overlay artifact ${overlayArtifactId} is not an image`);
    }

    const baseStorageResult = await this.storage.get(baseArtifactId);
    const overlayStorageResult = await this.storage.get(overlayArtifactId);

    const baseBuffer = await this.streamToBuffer(baseStorageResult.data as Readable);
    const overlayBuffer = await this.streamToBuffer(overlayStorageResult.data as Readable);

    const baseImage = sharp(baseBuffer);
    const baseMetadata = await baseImage.metadata();

    const overlayInput = sharp(overlayBuffer);

    const compositeOptions: sharp.OverlayOptions = {
      input: await overlayInput.png().toBuffer(),
      blend: config.blend,
      gravity: config.gravity,
    };

    if (config.opacity !== undefined) {
      (compositeOptions as any).opacity = config.opacity;
    }

    if (config.top !== undefined) {
      compositeOptions.top = config.top;
    }
    if (config.left !== undefined) {
      compositeOptions.left = config.left;
    }

    const outputBuffer = await baseImage.composite([compositeOptions]).png().toBuffer();

    const newId = `artifact-${uuidv4()}`;

    const meta: ArtifactMeta = {
      id: newId,
      type: 'image',
      mimeType: 'image/png',
      size: outputBuffer.length,
      sourceArtifact: baseArtifactId,
      overlayArtifact: overlayArtifactId,
      operation: 'composite',
      width: baseMetadata.width,
      height: baseMetadata.height,
    } as ArtifactMeta;

    const uri = await this.storage.put(newId, outputBuffer, meta);

    const newArtifact: Artifact = {
      id: newId,
      type: 'image',
      uri,
      mimeType: 'image/png',
      metadata: {
        width: baseMetadata.width,
        height: baseMetadata.height,
        sourceArtifact: baseArtifactId,
        overlayArtifact: overlayArtifactId,
        operation: 'composite',
      },
      sourceStep: baseArtifact.sourceStep,
    };

    this.artifactRegistry.register(newArtifact);
    return newArtifact;
  }

  async upscale(config: UpscaleConfig): Promise<Artifact> {
    const artifact = this.artifactRegistry.get(config.artifactId);
    if (!artifact || artifact.type !== 'image') {
      throw new Error(`Artifact ${config.artifactId} is not an image`);
    }

    const provider = this.getProvider('image.upscale', config.provider);

    if (!provider) {
      throw new Error('No provider available for image.upscale operation');
    }

    const storageResult = await this.storage.get(config.artifactId);
    const imageData = await this.streamToBuffer(storageResult.data as Readable);

    const input: ProviderInput = {
      operation: 'image.upscale',
      config: {},
      params: {
        image_data: imageData,
        scale: config.scale || 4,
        model: config.model || 'real-esrgan',
      },
    };

    const result = await provider.execute(input);
    const newId = `artifact-${uuidv4()}`;

    const meta: ArtifactMeta = {
      id: newId,
      type: 'image',
      mimeType: result.mimeType,
      size: (result.data as Buffer).length,
      metadata: {
        sourceArtifact: config.artifactId,
        operation: 'upscale',
        scale: config.scale || 4,
        model: config.model || 'real-esrgan',
        provider: provider.name,
        costUsd: result.costUsd,
      },
    };

    const uri = await this.storage.put(newId, result.data as Buffer, meta);

    const newArtifact: Artifact = {
      id: newId,
      type: 'image',
      uri,
      mimeType: result.mimeType,
      metadata: meta.metadata || {},
      sourceStep: artifact.sourceStep,
    };

    this.artifactRegistry.register(newArtifact);
    return newArtifact;
  }

  async removeBackground(config: RemoveBackgroundConfig): Promise<Artifact> {
    const artifact = this.artifactRegistry.get(config.artifactId);
    if (!artifact || artifact.type !== 'image') {
      throw new Error(`Artifact ${config.artifactId} is not an image`);
    }

    const provider = this.getProvider('image.remove_background', config.provider);

    if (!provider) {
      throw new Error('No provider available for image.remove_background operation');
    }

    const storageResult = await this.storage.get(config.artifactId);
    const imageData = await this.streamToBuffer(storageResult.data as Readable);

    const input: ProviderInput = {
      operation: 'image.remove_background',
      config: {},
      params: {
        image_data: imageData,
      },
    };

    const result = await provider.execute(input);
    const newId = `artifact-${uuidv4()}`;

    const meta: ArtifactMeta = {
      id: newId,
      type: 'image',
      mimeType: result.mimeType,
      size: (result.data as Buffer).length,
      metadata: {
        sourceArtifact: config.artifactId,
        operation: 'remove_background',
        provider: provider.name,
        costUsd: result.costUsd,
      },
    };

    const uri = await this.storage.put(newId, result.data as Buffer, meta);

    const newArtifact: Artifact = {
      id: newId,
      type: 'image',
      uri,
      mimeType: result.mimeType,
      metadata: meta.metadata || {},
      sourceStep: artifact.sourceStep,
    };

    this.artifactRegistry.register(newArtifact);
    return newArtifact;
  }

  async inpaint(config: InpaintConfig): Promise<Artifact> {
    const artifact = this.artifactRegistry.get(config.artifactId);
    if (!artifact || artifact.type !== 'image') {
      throw new Error(`Artifact ${config.artifactId} is not an image`);
    }

    const provider = this.getProvider('image.inpaint', config.provider);

    if (!provider) {
      throw new Error('No provider available for image.inpaint operation');
    }

    const storageResult = await this.storage.get(config.artifactId);
    const imageData = await this.streamToBuffer(storageResult.data as Readable);

    let maskData: Buffer | undefined;
    if (config.maskArtifactId) {
      const maskArtifact = this.artifactRegistry.get(config.maskArtifactId);
      if (maskArtifact) {
        const maskStorageResult = await this.storage.get(config.maskArtifactId);
        maskData = await this.streamToBuffer(maskStorageResult.data as Readable);
      }
    }

    const input: ProviderInput = {
      operation: 'image.inpaint',
      config: {},
      params: {
        image_data: imageData,
        mask_data: maskData,
        prompt: config.prompt,
      },
    };

    const result = await provider.execute(input);
    const newId = `artifact-${uuidv4()}`;

    const meta: ArtifactMeta = {
      id: newId,
      type: 'image',
      mimeType: result.mimeType,
      size: (result.data as Buffer).length,
      metadata: {
        sourceArtifact: config.artifactId,
        operation: 'inpaint',
        prompt: config.prompt,
        hasMask: !!config.maskArtifactId,
        provider: provider.name,
        costUsd: result.costUsd,
      },
    };

    const uri = await this.storage.put(newId, result.data as Buffer, meta);

    const newArtifact: Artifact = {
      id: newId,
      type: 'image',
      uri,
      mimeType: result.mimeType,
      metadata: meta.metadata || {},
      sourceStep: artifact.sourceStep,
    };

    this.artifactRegistry.register(newArtifact);
    return newArtifact;
  }

  async describe(config: DescribeConfig): Promise<Artifact> {
    const artifact = this.artifactRegistry.get(config.artifactId);
    if (!artifact || artifact.type !== 'image') {
      throw new Error(`Artifact ${config.artifactId} is not an image`);
    }

    const provider = this.getProvider('image.describe', config.provider);

    if (!provider) {
      throw new Error('No provider available for image.describe operation');
    }

    const storageResult = await this.storage.get(config.artifactId);
    const imageData = await this.streamToBuffer(storageResult.data as Readable);

    const detail = config.detail || 'detailed';

    const input: ProviderInput = {
      operation: 'image.describe',
      config: {},
      params: {
        artifact_data: imageData,
        detail,
        model: 'gpt-4o',
      },
    };

    const result = await provider.execute(input);
    const newId = `artifact-${uuidv4()}`;

    const meta: ArtifactMeta = {
      id: newId,
      type: 'text',
      mimeType: 'text/plain',
      size: (result.data as Buffer).length,
      metadata: {
        sourceArtifact: config.artifactId,
        operation: 'describe',
        detail,
        provider: provider.name,
        costUsd: result.costUsd,
      },
    };

    const uri = await this.storage.put(newId, result.data as Buffer, meta);

    const newArtifact: Artifact = {
      id: newId,
      type: 'text',
      uri,
      mimeType: 'text/plain',
      metadata: meta.metadata || {},
      sourceStep: artifact.sourceStep,
    };

    this.artifactRegistry.register(newArtifact);
    return newArtifact;
  }

  private async streamToBuffer(stream: Readable): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }
}

export function createImageEditOperations(
  artifactRegistry: ArtifactRegistry,
  storage: ArtifactStore,
): ImageEditOperations {
  return new ImageEditOperations(artifactRegistry, storage);
}
