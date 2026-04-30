import { beforeEach, describe, expect, it } from 'vitest';
import { ToolRegistry, toolRegistry } from './tool-registry.js';

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  describe('tool registration', () => {
    it('should register image generation tools', () => {
      const tools = registry.getToolsByCategory('image');
      expect(tools).toHaveLength(10);

      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain('image.generate');
      expect(toolNames).toContain('image.generate.batch');
      expect(toolNames).toContain('image.image_to_image');
      expect(toolNames).toContain('image.upscale');
      expect(toolNames).toContain('image.remove_background');
      expect(toolNames).toContain('image.inpaint');
      expect(toolNames).toContain('image.describe');
      expect(toolNames).toContain('image.resize');
      expect(toolNames).toContain('image.crop');
      expect(toolNames).toContain('image.composite');
    });

    it('should register audio tools', () => {
      const tools = registry.getToolsByCategory('audio');
      expect(tools).toHaveLength(6);

      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain('audio.tts');
      expect(toolNames).toContain('audio.stt');
      expect(toolNames).toContain('audio.diarize');
      expect(toolNames).toContain('audio.isolate');
      expect(toolNames).toContain('audio.music');
      expect(toolNames).toContain('audio.sound_effect');
    });

    it('should register video tools', () => {
      const tools = registry.getToolsByCategory('video');
      expect(tools).toHaveLength(4);

      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain('video.generate');
      expect(toolNames).toContain('video.image_to_video');
      expect(toolNames).toContain('video.extract_frames');
      expect(toolNames).toContain('video.extract_audio');
    });

    it('should register document tools', () => {
      const tools = registry.getToolsByCategory('document');
      expect(tools).toHaveLength(4);

      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain('document.ocr');
      expect(toolNames).toContain('document.extract_tables');
      expect(toolNames).toContain('document.extract_fields');
      expect(toolNames).toContain('document.summarize');
    });

    it('should register cost tool', () => {
      const tools = registry.getToolsByCategory('cost');
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('media.costs.summary');
    });
  });

  describe('tool lookup', () => {
    it('should find tool by name', () => {
      const tool = registry.getTool('image.generate');
      expect(tool).toBeDefined();
      expect(tool?.name).toBe('image.generate');
      expect(tool?.category).toBe('image');
    });

    it('should return undefined for unknown tool', () => {
      const tool = registry.getTool('unknown.tool');
      expect(tool).toBeUndefined();
    });

    it('should find tool for operation', () => {
      const tool = registry.getToolForOperation('image.generate');
      expect(tool).toBeDefined();
      expect(tool?.name).toBe('image.generate');
    });

    it('should return undefined for unmapped operation', () => {
      const tool = registry.getToolForOperation('media.costs.summary');
      expect(tool).toBeUndefined();
    });
  });

  describe('all tools', () => {
    it('should get all tools', () => {
      const tools = registry.getAllTools();
      expect(tools.length).toBeGreaterThan(0);
    });

    it('should have unique tool names', () => {
      const tools = registry.getAllTools();
      const names = tools.map((t) => t.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(names.length);
    });

    it('should convert to MCP tools format', () => {
      const mcpTools = registry.toMCPTools();
      expect(mcpTools.length).toBeGreaterThan(0);

      for (const tool of mcpTools) {
        expect(tool).toHaveProperty('name');
        expect(tool).toHaveProperty('description');
        expect(tool).toHaveProperty('inputSchema');
      }
    });
  });

  describe('supported operations', () => {
    it('should get supported operations', () => {
      const operations = registry.getSupportedOperations();
      expect(operations.length).toBeGreaterThan(0);
    });

    it('should include key operations', () => {
      const operations = registry.getSupportedOperations();
      expect(operations).toContain('image.generate');
      expect(operations).toContain('audio.tts');
      expect(operations).toContain('video.generate');
      expect(operations).toContain('document.ocr');
    });

    it('should check if operation is supported', () => {
      expect(registry.isOperationSupported('image.generate')).toBe(true);
      expect(registry.isOperationSupported('unknown.operation')).toBe(false);
    });
  });

  describe('input schemas', () => {
    it('should have valid input schema for image.generate', () => {
      const tool = registry.getTool('image.generate');
      expect(tool?.inputSchema).toBeDefined();
      expect(tool?.inputSchema.type).toBe('object');
      expect(tool?.inputSchema.required).toContain('prompt');
    });

    it('should have valid input schema for audio.tts', () => {
      const tool = registry.getTool('audio.tts');
      expect(tool?.inputSchema).toBeDefined();
      expect(tool?.inputSchema.type).toBe('object');
      expect(tool?.inputSchema.required).toContain('text');
    });

    it('should have valid input schema for video.generate', () => {
      const tool = registry.getTool('video.generate');
      expect(tool?.inputSchema).toBeDefined();
      expect(tool?.inputSchema.type).toBe('object');
      expect(tool?.inputSchema.required).toContain('prompt');
    });

    it('should have valid input schema for document.ocr', () => {
      const tool = registry.getTool('document.ocr');
      expect(tool?.inputSchema).toBeDefined();
      expect(tool?.inputSchema.type).toBe('object');
      expect(tool?.inputSchema.required).toContain('artifact_id');
    });
  });

  describe('tool descriptions', () => {
    it('should have descriptions for all tools', () => {
      const tools = registry.getAllTools();
      for (const tool of tools) {
        expect(tool.description).toBeTruthy();
        expect(tool.description.length).toBeGreaterThan(0);
      }
    });
  });
});

describe('toolRegistry singleton', () => {
  it('should export a singleton instance', () => {
    expect(toolRegistry).toBeDefined();
    expect(toolRegistry).toBeInstanceOf(ToolRegistry);
  });

  it('should have all tools registered', () => {
    const tools = toolRegistry.getAllTools();
    // Should have at least 22 tools (9 image + 4 audio + 4 video + 4 document + 1 cost)
    expect(tools.length).toBeGreaterThanOrEqual(22);
  });
});
