import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Readable } from 'node:stream';
import type { ArtifactRegistry } from '@reaatech/media-pipeline-mcp';
import type { Artifact } from '@reaatech/media-pipeline-mcp';
import type { MediaProvider, ProviderInput } from '@reaatech/media-pipeline-mcp-provider-core';
import type { ArtifactMeta, ArtifactStore } from '@reaatech/media-pipeline-mcp-storage';
import { v4 as uuidv4 } from 'uuid';

export interface VideoGenerateConfig {
  prompt: string;
  duration?: number; // seconds, default 5
  aspectRatio?: '16:9' | '9:16' | '1:1' | '4:3';
  style?: string;
  provider?: string; // Provider name to use (e.g., 'replicate', 'fal')
}

export interface ImageToVideoConfig {
  artifactId: string;
  motionPrompt?: string;
  duration?: number; // seconds, default 5
  provider?: string; // Provider name to use
}

export interface ExtractFramesConfig {
  artifactId: string;
  interval?: number; // Extract every Nth frame, default 30 (1 frame per second at 30fps)
  timestamps?: number[]; // Or extract at specific timestamps (in seconds)
}

export interface ExtractAudioConfig {
  artifactId: string;
}

export class VideoGenOperations {
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

  private async streamToBuffer(stream: Readable): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }

  async generate(config: VideoGenerateConfig): Promise<Artifact> {
    const provider = this.getProvider('video.generate', config.provider);

    if (!provider) {
      throw new Error('No provider available for video.generate operation');
    }

    const duration = config.duration || 5;
    const aspectRatio = config.aspectRatio || '16:9';

    const input: ProviderInput = {
      operation: 'video.generate',
      config: {},
      params: {
        prompt: config.prompt,
        duration,
        aspect_ratio: aspectRatio,
        style: config.style,
        model: 'kling',
      },
    };

    const result = await provider.execute(input);
    const newId = `artifact-${uuidv4()}`;

    const meta: ArtifactMeta = {
      id: newId,
      type: 'video',
      mimeType: result.mimeType,
      size: (result.data as Buffer).length,
      metadata: {
        operation: 'video.generate',
        prompt: config.prompt,
        duration,
        aspectRatio,
        style: config.style,
        fps: 30,
        codec: 'h264',
        provider: provider.name,
        costUsd: result.costUsd,
      },
    };

    const uri = await this.storage.put(newId, result.data as Buffer, meta);

    const newArtifact: Artifact = {
      id: newId,
      type: 'video',
      uri,
      mimeType: result.mimeType,
      metadata: meta.metadata || {},
      sourceStep: undefined,
    };

    this.artifactRegistry.register(newArtifact);
    return newArtifact;
  }

  async imageToVideo(config: ImageToVideoConfig): Promise<Artifact> {
    const artifact = this.artifactRegistry.get(config.artifactId);
    if (!artifact || artifact.type !== 'image') {
      throw new Error(`Artifact ${config.artifactId} is not an image`);
    }

    const provider = this.getProvider('video.image_to_video', config.provider);

    if (!provider) {
      throw new Error('No provider available for video.image_to_video operation');
    }

    const storageResult = await this.storage.get(config.artifactId);
    const imageData = await this.streamToBuffer(storageResult.data as Readable);

    const duration = config.duration || 5;

    const input: ProviderInput = {
      operation: 'video.image_to_video',
      config: {},
      params: {
        image_data: imageData,
        motion_prompt: config.motionPrompt,
        duration,
        model: 'kling-i2v',
      },
    };

    const result = await provider.execute(input);
    const newId = `artifact-${uuidv4()}`;

    const meta: ArtifactMeta = {
      id: newId,
      type: 'video',
      mimeType: result.mimeType,
      size: (result.data as Buffer).length,
      metadata: {
        operation: 'video.image_to_video',
        sourceArtifact: config.artifactId,
        motionPrompt: config.motionPrompt,
        duration,
        fps: 30,
        codec: 'h264',
        provider: provider.name,
        costUsd: result.costUsd,
      },
    };

    const uri = await this.storage.put(newId, result.data as Buffer, meta);

    const newArtifact: Artifact = {
      id: newId,
      type: 'video',
      uri,
      mimeType: result.mimeType,
      metadata: meta.metadata || {},
      sourceStep: artifact.sourceStep,
    };

    this.artifactRegistry.register(newArtifact);
    return newArtifact;
  }

  async extractFrames(config: ExtractFramesConfig): Promise<Artifact[]> {
    const artifact = this.artifactRegistry.get(config.artifactId);
    if (!artifact || artifact.type !== 'video') {
      throw new Error(`Artifact ${config.artifactId} is not a video`);
    }

    const storageResult = await this.storage.get(config.artifactId);
    const videoData = await this.streamToBuffer(storageResult.data as Readable);

    // Write video to temp file for ffmpeg processing
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-frames-'));
    const tempVideoPath = path.join(tempDir, 'input.mp4');
    fs.writeFileSync(tempVideoPath, videoData);

    const duration = (artifact.metadata.duration as number) || 5;
    const fps = (artifact.metadata.fps as number) || 30;
    const interval = config.interval || fps; // Default: 1 frame per second

    // Calculate frames to extract
    let frameTimestamps: number[];

    if (config.timestamps && config.timestamps.length > 0) {
      frameTimestamps = config.timestamps;
    } else {
      const frameCount = Math.ceil(duration / (interval / fps));
      frameTimestamps = [];
      for (let i = 0; i < frameCount; i++) {
        frameTimestamps.push((i * interval) / fps);
      }
    }

    const extractedArtifacts: Artifact[] = [];

    for (let i = 0; i < frameTimestamps.length; i++) {
      const timestamp = frameTimestamps[i];
      const newId = `artifact-${uuidv4()}`;
      const framePath = path.join(tempDir, `frame-${i}.png`);

      // Use ffmpeg to extract frame at timestamp
      await this.extractFrameWithFfmpeg(tempVideoPath, timestamp, framePath);

      const frameBuffer = fs.readFileSync(framePath);

      const meta: ArtifactMeta = {
        id: newId,
        type: 'image',
        mimeType: 'image/png',
        size: frameBuffer.length,
        metadata: {
          operation: 'video.extract_frames',
          sourceArtifact: config.artifactId,
          timestamp,
          frameIndex: i,
          width: (artifact.metadata.width as number) || 1920,
          height: (artifact.metadata.height as number) || 1080,
        },
      };

      const uri = await this.storage.put(newId, frameBuffer, meta);

      const frameArtifact: Artifact = {
        id: newId,
        type: 'image',
        uri,
        mimeType: 'image/png',
        metadata: meta.metadata || {},
        sourceStep: artifact.sourceStep,
      };

      this.artifactRegistry.register(frameArtifact);
      extractedArtifacts.push(frameArtifact);
    }

    // Cleanup temp files
    fs.rmSync(tempDir, { recursive: true, force: true });

    return extractedArtifacts;
  }

  /**
   * Extract a single frame from video using ffmpeg
   */
  private extractFrameWithFfmpeg(
    videoPath: string,
    timestamp: number,
    outputPath: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = [
        '-ss',
        timestamp.toString(),
        '-i',
        videoPath,
        '-vframes',
        '1',
        '-q:v',
        '2',
        outputPath,
      ];

      const ffmpeg = spawn('ffmpeg', args);

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`ffmpeg exited with code ${code}`));
        }
      });

      ffmpeg.on('error', (err) => {
        reject(err);
      });
    });
  }

  async extractAudio(config: ExtractAudioConfig): Promise<Artifact> {
    const artifact = this.artifactRegistry.get(config.artifactId);
    if (!artifact || artifact.type !== 'video') {
      throw new Error(`Artifact ${config.artifactId} is not a video`);
    }

    const storageResult = await this.storage.get(config.artifactId);
    const videoData = await this.streamToBuffer(storageResult.data as Readable);

    // Write video to temp file for ffmpeg processing
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-audio-'));
    const tempVideoPath = path.join(tempDir, 'input.mp4');
    fs.writeFileSync(tempVideoPath, videoData);
    const tempAudioPath = path.join(tempDir, 'audio.aac');

    const duration = (artifact.metadata.duration as number) || 5;

    // Use ffmpeg to extract audio
    await this.extractAudioWithFfmpeg(tempVideoPath, tempAudioPath);

    const audioBuffer = fs.readFileSync(tempAudioPath);
    const newId = `artifact-${uuidv4()}`;

    const meta: ArtifactMeta = {
      id: newId,
      type: 'audio',
      mimeType: 'audio/aac',
      size: audioBuffer.length,
      metadata: {
        operation: 'video.extract_audio',
        sourceArtifact: config.artifactId,
        duration,
        sampleRate: 48000,
        channels: 2,
        codec: 'aac',
      },
    };

    const uri = await this.storage.put(newId, audioBuffer, meta);

    // Cleanup temp files
    fs.rmSync(tempDir, { recursive: true, force: true });

    const newArtifact: Artifact = {
      id: newId,
      type: 'audio',
      uri,
      mimeType: 'audio/aac',
      metadata: meta.metadata || {},
      sourceStep: artifact.sourceStep,
    };

    this.artifactRegistry.register(newArtifact);
    return newArtifact;
  }

  /**
   * Extract audio from video using ffmpeg
   */
  private extractAudioWithFfmpeg(videoPath: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = ['-i', videoPath, '-q:a', '0', '-map', 'a', outputPath];

      const ffmpeg = spawn('ffmpeg', args);

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`ffmpeg exited with code ${code}`));
        }
      });

      ffmpeg.on('error', (err) => {
        reject(err);
      });
    });
  }
}

export function createVideoGenOperations(
  artifactRegistry: ArtifactRegistry,
  storage: ArtifactStore,
): VideoGenOperations {
  return new VideoGenOperations(artifactRegistry, storage);
}
