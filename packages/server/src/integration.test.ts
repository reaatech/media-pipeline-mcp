import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from './config.js';
import { MCPServer } from './mcp-server.js';
import { toolRegistry } from './tool-registry.js';

// Mock storage
vi.mock('@reaatech/media-pipeline-mcp-storage', () => ({
  createStorage: () => ({
    put: vi.fn().mockResolvedValue('uri'),
    get: vi.fn().mockResolvedValue({
      data: Buffer.from('test'),
      meta: { type: 'image', mimeType: 'image/png' },
    }),
    getSignedUrl: vi.fn().mockResolvedValue('signed-url'),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
  }),
}));

describe('MCPServer Integration', () => {
  let server: MCPServer;

  const config: ServerConfig = {
    port: 8080,
    logLevel: 'info',
    storage: {
      type: 'local',
      config: {
        basePath: './artifacts',
      },
    },
    providers: [],
  };

  beforeEach(() => {
    server = new MCPServer(config);
  });

  describe('Tool Registration', () => {
    it('should register all required tools', () => {
      const tools = toolRegistry.getAllTools();

      // Image operations
      expect(tools.find((t) => t.name === 'image.generate')).toBeDefined();
      expect(tools.find((t) => t.name === 'image.generate.batch')).toBeDefined();
      expect(tools.find((t) => t.name === 'image.upscale')).toBeDefined();
      expect(tools.find((t) => t.name === 'image.remove_background')).toBeDefined();
      expect(tools.find((t) => t.name === 'image.inpaint')).toBeDefined();
      expect(tools.find((t) => t.name === 'image.describe')).toBeDefined();
      expect(tools.find((t) => t.name === 'image.resize')).toBeDefined();
      expect(tools.find((t) => t.name === 'image.crop')).toBeDefined();
      expect(tools.find((t) => t.name === 'image.composite')).toBeDefined();

      // Audio operations
      expect(tools.find((t) => t.name === 'audio.tts')).toBeDefined();
      expect(tools.find((t) => t.name === 'audio.stt')).toBeDefined();
      expect(tools.find((t) => t.name === 'audio.diarize')).toBeDefined();
      expect(tools.find((t) => t.name === 'audio.isolate')).toBeDefined();

      // Video operations
      expect(tools.find((t) => t.name === 'video.generate')).toBeDefined();
      expect(tools.find((t) => t.name === 'video.image_to_video')).toBeDefined();
      expect(tools.find((t) => t.name === 'video.extract_frames')).toBeDefined();
      expect(tools.find((t) => t.name === 'video.extract_audio')).toBeDefined();

      // Document operations
      expect(tools.find((t) => t.name === 'document.ocr')).toBeDefined();
      expect(tools.find((t) => t.name === 'document.extract_tables')).toBeDefined();
      expect(tools.find((t) => t.name === 'document.extract_fields')).toBeDefined();
      expect(tools.find((t) => t.name === 'document.summarize')).toBeDefined();

      // Cost operation
      expect(tools.find((t) => t.name === 'media.costs.summary')).toBeDefined();
    });

    it('should have correct input schemas for all tools', () => {
      const tools = toolRegistry.getAllTools();

      for (const tool of tools) {
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.description).toBeTruthy();
      }
    });

    it('should have correct tool categories', () => {
      const imageTools = toolRegistry.getToolsByCategory('image');
      const audioTools = toolRegistry.getToolsByCategory('audio');
      const videoTools = toolRegistry.getToolsByCategory('video');
      const documentTools = toolRegistry.getToolsByCategory('document');

      expect(imageTools.length).toBe(10);
      expect(audioTools.length).toBe(6);
      expect(videoTools.length).toBe(4);
      expect(documentTools.length).toBe(4);
    });
  });

  describe('Tool to MCP Conversion', () => {
    it('should convert tools to MCP format correctly', () => {
      const mcpTools = toolRegistry.toMCPTools();

      expect(mcpTools.length).toBeGreaterThan(0);

      for (const tool of mcpTools) {
        expect(tool.name).toBeDefined();
        expect(tool.description).toBeDefined();
        expect(tool.inputSchema).toBeDefined();
      }
    });
  });

  describe('Operation Support', () => {
    it('should support all required operations', () => {
      const supportedOps = toolRegistry.getSupportedOperations();

      // Check key operations
      expect(supportedOps).toContain('image.generate');
      expect(supportedOps).toContain('image.upscale');
      expect(supportedOps).toContain('audio.tts');
      expect(supportedOps).toContain('audio.stt');
      expect(supportedOps).toContain('video.generate');
      expect(supportedOps).toContain('document.ocr');
    });
  });

  describe('Tool Lookup', () => {
    it('should find tool by name', () => {
      const tool = toolRegistry.getTool('image.generate');
      expect(tool).toBeDefined();
      expect(tool?.name).toBe('image.generate');
      expect(tool?.category).toBe('image');
    });

    it('should find tool for operation', () => {
      const tool = toolRegistry.getToolForOperation('image.generate');
      expect(tool).toBeDefined();
      expect(tool?.name).toBe('image.generate');
    });

    it('should return undefined for unknown tool', () => {
      const tool = toolRegistry.getTool('unknown.tool');
      expect(tool).toBeUndefined();
    });
  });

  describe('Server Initialization', () => {
    it('should initialize server without errors', () => {
      expect(server).toBeDefined();
    });
  });
});
