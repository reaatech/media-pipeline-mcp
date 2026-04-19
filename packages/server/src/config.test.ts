import { describe, it, expect } from 'vitest';
import { loadConfig, validateConfig, ServerConfigSchema } from './config.js';

describe('config', () => {
  describe('loadConfig', () => {
    it('should load default config with local storage', () => {
      const config = loadConfig({});

      expect(config.port).toBe(8080);
      expect(config.host).toBe('0.0.0.0');
      expect(config.logLevel).toBe('info');
      expect(config.storage.type).toBe('local');
      if (config.storage.type === 'local') {
        expect(config.storage.config.basePath).toBe('./artifacts');
      }
    });

    it('should load S3 config from environment', () => {
      const config = loadConfig({
        STORAGE_TYPE: 's3',
        S3_BUCKET: 'my-bucket',
        S3_REGION: 'us-west-2',
        S3_PREFIX: 'custom-prefix/',
      });

      expect(config.storage.type).toBe('s3');
      if (config.storage.type === 's3') {
        expect(config.storage.config.bucket).toBe('my-bucket');
        expect(config.storage.config.region).toBe('us-west-2');
        expect(config.storage.config.prefix).toBe('custom-prefix/');
      }
    });

    it('should load GCS config from environment', () => {
      const config = loadConfig({
        STORAGE_TYPE: 'gcs',
        GCS_BUCKET: 'gcs-bucket',
        GCS_PREFIX: 'gcs-prefix/',
      });

      expect(config.storage.type).toBe('gcs');
      if (config.storage.type === 'gcs') {
        expect(config.storage.config.bucket).toBe('gcs-bucket');
        expect(config.storage.config.prefix).toBe('gcs-prefix/');
      }
    });

    it('should load Google provider config from environment', () => {
      const config = loadConfig({
        GOOGLE_PROJECT_ID: 'test-project',
        GOOGLE_LOCATION: 'us-central1',
        GOOGLE_DOCUMENT_AI_PROCESSOR_ID: 'processor-123',
        GOOGLE_GEMINI_MODEL: 'gemini-2.5-pro',
        GOOGLE_KEY_FILE: '/tmp/google.json',
      });

      expect(config.providers).toHaveLength(1);
      expect(config.providers[0]).toEqual({
        name: 'google',
        operations: [
          'document.ocr',
          'document.extract_tables',
          'document.extract_fields',
          'image.describe',
        ],
        config: {
          projectId: 'test-project',
          location: 'us-central1',
          documentAiProcessorId: 'processor-123',
          geminiModel: 'gemini-2.5-pro',
          keyFile: '/tmp/google.json',
        },
      });
    });

    it('should load config with custom port and host', () => {
      const config = loadConfig({
        PORT: '3000',
        HOST: 'localhost',
      });

      expect(config.port).toBe(3000);
      expect(config.host).toBe('localhost');
    });

    it('should load config with custom log level', () => {
      const config = loadConfig({
        LOG_LEVEL: 'debug',
      });

      expect(config.logLevel).toBe('debug');
    });

    it('should load local config with TTL', () => {
      const config = loadConfig({
        STORAGE_TTL: '3600',
      });

      expect(config.storage.type).toBe('local');
      if (config.storage.type === 'local') {
        expect(config.storage.config.ttl).toBe(3600000);
      }
    });

    it('should load local config with HTTP serve enabled', () => {
      const config = loadConfig({
        STORAGE_SERVE_HTTP: 'true',
        STORAGE_TYPE: 'local',
      });

      expect(config.storage.type).toBe('local');
      if (config.storage.type === 'local') {
        expect(config.storage.config.serveHttp).toBe(true);
      }
    });
  });

  describe('validateConfig', () => {
    it('should validate a valid config object', () => {
      const config = {
        port: 8080,
        host: '0.0.0.0',
        logLevel: 'info' as const,
        storage: {
          type: 'local' as const,
          config: {
            basePath: './artifacts',
          },
        },
      };

      const validated = validateConfig(config);
      expect(validated.port).toBe(8080);
    });

    it('should throw on invalid config', () => {
      const invalidConfig = {
        port: 'not-a-number',
        storage: {
          type: 'local',
        },
      };

      expect(() => validateConfig(invalidConfig)).toThrow();
    });

    it('should validate config with S3 storage', () => {
      const config = {
        storage: {
          type: 's3',
          config: {
            bucket: 'my-bucket',
            region: 'us-east-1',
          },
        },
      };

      const validated = validateConfig(config);
      expect(validated.storage.type).toBe('s3');
    });

    it('should validate config with GCS storage', () => {
      const config = {
        storage: {
          type: 'gcs',
          config: {
            bucket: 'my-bucket',
            projectId: 'my-project',
          },
        },
      };

      const validated = validateConfig(config);
      expect(validated.storage.type).toBe('gcs');
    });
  });

  describe('ServerConfigSchema', () => {
    it('should have correct default values', () => {
      const config = {
        storage: {
          type: 'local',
          config: { basePath: './artifacts' },
        },
      };

      const result = ServerConfigSchema.parse(config);

      expect(result.port).toBe(8080);
      expect(result.host).toBe('0.0.0.0');
      expect(result.logLevel).toBe('info');
      expect(result.providers).toEqual([]);
    });

    it('should reject invalid log level', () => {
      const config = {
        storage: {
          type: 'local',
          config: { basePath: './artifacts' },
        },
        logLevel: 'invalid',
      };

      expect(() => ServerConfigSchema.parse(config)).toThrow();
    });

    it('should reject missing required storage', () => {
      const config = {
        port: 8080,
      };

      expect(() => ServerConfigSchema.parse(config)).toThrow();
    });
  });
});
