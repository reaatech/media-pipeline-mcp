import { beforeEach, describe, expect, it } from 'vitest';
import { ArtifactRegistry } from './artifact-registry.js';

describe('ArtifactRegistry', () => {
  let registry: ArtifactRegistry;

  beforeEach(() => {
    registry = new ArtifactRegistry();
  });

  describe('register', () => {
    it('should register an artifact and return it with generated id', () => {
      const artifact = registry.register({
        type: 'video',
        uri: 'file:///video.mp4',
        mimeType: 'video/mp4',
        metadata: { duration: 5 },
      });

      expect(artifact.id).toBeDefined();
      expect(artifact.type).toBe('video');
      expect(artifact.uri).toBe('file:///video.mp4');
      expect(artifact.mimeType).toBe('video/mp4');
      expect(artifact.metadata).toEqual({ duration: 5 });
      expect(artifact.createdAt).toBeDefined();
    });

    it('should generate unique ids for each artifact', () => {
      const artifact1 = registry.register({
        type: 'image',
        uri: 'file:///image1.png',
        mimeType: 'image/png',
        metadata: {},
      });

      const artifact2 = registry.register({
        type: 'image',
        uri: 'file:///image2.png',
        mimeType: 'image/png',
        metadata: {},
      });

      expect(artifact1.id).not.toBe(artifact2.id);
    });
  });

  describe('get', () => {
    it('should return an artifact by id', () => {
      const artifact = registry.register({
        type: 'text',
        uri: 'file:///text.txt',
        mimeType: 'text/plain',
        metadata: {},
      });

      const retrieved = registry.get(artifact.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(artifact.id);
    });

    it('should return undefined for non-existent id', () => {
      const result = registry.get('non-existent-id');
      expect(result).toBeUndefined();
    });
  });

  describe('delete', () => {
    it('should delete an artifact and return true', () => {
      const artifact = registry.register({
        type: 'audio',
        uri: 'file:///audio.mp3',
        mimeType: 'audio/mpeg',
        metadata: {},
      });

      const deleted = registry.delete(artifact.id);
      expect(deleted).toBe(true);
      expect(registry.get(artifact.id)).toBeUndefined();
    });

    it('should return false for non-existent id', () => {
      const deleted = registry.delete('non-existent-id');
      expect(deleted).toBe(false);
    });
  });

  describe('list', () => {
    it('should return all registered artifacts', () => {
      registry.register({
        type: 'video',
        uri: 'file:///v1.mp4',
        mimeType: 'video/mp4',
        metadata: {},
      });
      registry.register({
        type: 'image',
        uri: 'file:///i1.png',
        mimeType: 'image/png',
        metadata: {},
      });
      registry.register({
        type: 'audio',
        uri: 'file:///a1.mp3',
        mimeType: 'audio/mpeg',
        metadata: {},
      });

      const artifacts = registry.list();
      expect(artifacts.length).toBe(3);
    });

    it('should return empty array when no artifacts registered', () => {
      const artifacts = registry.list();
      expect(artifacts).toEqual([]);
    });
  });

  describe('findBySourceStep', () => {
    it('should find artifact by sourceStep', () => {
      const artifact = registry.register({
        type: 'video',
        uri: 'file:///video.mp4',
        mimeType: 'video/mp4',
        metadata: {},
        sourceStep: 'step-123',
      });

      const found = registry.findBySourceStep('step-123');
      expect(found).toBeDefined();
      expect(found?.id).toBe(artifact.id);
    });

    it('should return undefined for non-existent sourceStep', () => {
      const found = registry.findBySourceStep('non-existent-step');
      expect(found).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('should remove all artifacts', () => {
      registry.register({
        type: 'video',
        uri: 'file:///v1.mp4',
        mimeType: 'video/mp4',
        metadata: {},
      });
      registry.register({
        type: 'image',
        uri: 'file:///i1.png',
        mimeType: 'image/png',
        metadata: {},
      });

      registry.clear();

      expect(registry.list()).toEqual([]);
      expect(registry.size()).toBe(0);
    });
  });

  describe('size', () => {
    it('should return the number of registered artifacts', () => {
      expect(registry.size()).toBe(0);

      registry.register({
        type: 'video',
        uri: 'file:///v1.mp4',
        mimeType: 'video/mp4',
        metadata: {},
      });
      expect(registry.size()).toBe(1);

      registry.register({
        type: 'image',
        uri: 'file:///i1.png',
        mimeType: 'image/png',
        metadata: {},
      });
      expect(registry.size()).toBe(2);
    });
  });
});
