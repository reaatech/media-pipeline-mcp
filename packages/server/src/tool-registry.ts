import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  category:
    | 'image'
    | 'audio'
    | 'video'
    | 'document'
    | 'pipeline'
    | 'artifact'
    | 'provider'
    | 'cost';
  operations: string[]; // Which operations this tool supports
}

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();
  private operationToTool: Map<string, string> = new Map();

  constructor() {
    this.registerAllTools();
  }

  private registerAllTools(): void {
    // Image operations
    this.registerTool({
      name: 'image.generate',
      description: 'Generate an image from a text prompt',
      category: 'image',
      operations: ['image.generate'],
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Text description of the image' },
          negative_prompt: { type: 'string', description: 'What to exclude from the image' },
          dimensions: { type: 'string', description: 'Output dimensions (e.g., "1024x1024")' },
          aspect_ratio: { type: 'string', description: 'Aspect ratio (e.g., "1:1", "16:9")' },
          style_preset: { type: 'string', description: 'Style preset to apply' },
          seed: { type: 'number', description: 'Random seed for reproducibility' },
          num_outputs: { type: 'number', description: 'Number of images (1-10)', default: 1 },
          model: { type: 'string', description: 'Model to use (overrides default)' },
        },
        required: ['prompt'],
      },
    });

    this.registerTool({
      name: 'image.generate.batch',
      description: 'Generate multiple images from prompt variations',
      category: 'image',
      operations: ['image.generate.batch'],
      inputSchema: {
        type: 'object',
        properties: {
          prompts: { type: 'array', items: { type: 'string' }, description: 'Array of prompts' },
          negative_prompt: { type: 'string', description: 'What to exclude from all images' },
          dimensions: { type: 'string', description: 'Output dimensions' },
          aspect_ratio: { type: 'string', description: 'Aspect ratio' },
          style_preset: { type: 'string', description: 'Style preset' },
          num_variations: {
            type: 'number',
            description: 'Variations per prompt (1-5)',
            default: 1,
          },
        },
        required: ['prompts'],
      },
    });

    this.registerTool({
      name: 'image.upscale',
      description: 'Upscale an image to higher resolution',
      category: 'image',
      operations: ['image.upscale'],
      inputSchema: {
        type: 'object',
        properties: {
          artifact_id: { type: 'string', description: 'ID of the image to upscale' },
          scale: {
            type: 'string',
            description: 'Scale factor (e.g., "2x", "4x")',
            enum: ['2x', '4x', '8x'],
          },
          model: { type: 'string', description: 'Upscale model preference' },
        },
        required: ['artifact_id', 'scale'],
      },
    });

    this.registerTool({
      name: 'image.remove_background',
      description: 'Remove background from an image',
      category: 'image',
      operations: ['image.remove_background'],
      inputSchema: {
        type: 'object',
        properties: {
          artifact_id: { type: 'string', description: 'ID of the image' },
          output_format: { type: 'string', description: 'Output format', enum: ['png', 'webp'] },
        },
        required: ['artifact_id'],
      },
    });

    this.registerTool({
      name: 'image.inpaint',
      description: 'Inpaint or edit parts of an image',
      category: 'image',
      operations: ['image.inpaint'],
      inputSchema: {
        type: 'object',
        properties: {
          artifact_id: { type: 'string', description: 'ID of the image' },
          mask_artifact_id: { type: 'string', description: 'ID of the mask image' },
          prompt: { type: 'string', description: 'Description of what to inpaint' },
          negative_prompt: { type: 'string', description: 'What to exclude' },
        },
        required: ['artifact_id', 'prompt'],
      },
    });

    this.registerTool({
      name: 'image.describe',
      description: 'Generate a text description of an image',
      category: 'image',
      operations: ['image.describe'],
      inputSchema: {
        type: 'object',
        properties: {
          artifact_id: { type: 'string', description: 'ID of the image' },
          detail_level: {
            type: 'string',
            description: 'Level of detail',
            enum: ['brief', 'detailed', 'structured'],
          },
        },
        required: ['artifact_id'],
      },
    });

    this.registerTool({
      name: 'image.resize',
      description: 'Resize an image to new dimensions',
      category: 'image',
      operations: ['image.resize'],
      inputSchema: {
        type: 'object',
        properties: {
          artifact_id: { type: 'string', description: 'ID of the image' },
          dimensions: { type: 'string', description: 'Target dimensions (e.g., "800x600")' },
          fit: {
            type: 'string',
            description: 'Fit mode',
            enum: ['cover', 'contain', 'fill'],
            default: 'cover',
          },
        },
        required: ['artifact_id', 'dimensions'],
      },
    });

    this.registerTool({
      name: 'image.crop',
      description: 'Crop an image to a specific region',
      category: 'image',
      operations: ['image.crop'],
      inputSchema: {
        type: 'object',
        properties: {
          artifact_id: { type: 'string', description: 'ID of the image' },
          x: { type: 'number', description: 'X coordinate' },
          y: { type: 'number', description: 'Y coordinate' },
          width: { type: 'number', description: 'Crop width' },
          height: { type: 'number', description: 'Crop height' },
        },
        required: ['artifact_id', 'x', 'y', 'width', 'height'],
      },
    });

    this.registerTool({
      name: 'image.composite',
      description: 'Composite overlay one image onto another',
      category: 'image',
      operations: ['image.composite'],
      inputSchema: {
        type: 'object',
        properties: {
          base_artifact_id: { type: 'string', description: 'ID of the base image' },
          overlay_artifact_id: { type: 'string', description: 'ID of the overlay image' },
          position: { type: 'string', description: 'Position (e.g., "center", "top-left")' },
          opacity: { type: 'number', description: 'Opacity (0-1)', default: 1 },
          blend_mode: { type: 'string', description: 'Blend mode', default: 'normal' },
        },
        required: ['base_artifact_id', 'overlay_artifact_id'],
      },
    });

    this.registerTool({
      name: 'image.image_to_image',
      description: 'Transform an existing image based on a text prompt',
      category: 'image',
      operations: ['image.image_to_image'],
      inputSchema: {
        type: 'object',
        properties: {
          artifact_id: { type: 'string', description: 'ID of the source image' },
          prompt: { type: 'string', description: 'Text description of the transformation' },
          negative_prompt: {
            type: 'string',
            description: 'What to exclude from the transformation',
          },
          strength: { type: 'number', description: 'Transformation strength (0-1)', default: 0.5 },
          dimensions: { type: 'string', description: 'Output dimensions (e.g., "1024x1024")' },
          seed: { type: 'number', description: 'Random seed for reproducibility' },
        },
        required: ['artifact_id', 'prompt'],
      },
    });

    // Audio operations
    this.registerTool({
      name: 'audio.tts',
      description: 'Convert text to speech',
      category: 'audio',
      operations: ['audio.tts'],
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to convert to speech' },
          voice: { type: 'string', description: 'Voice to use' },
          speed: { type: 'number', description: 'Speech speed (0.5-2.0)', default: 1 },
          output_format: {
            type: 'string',
            description: 'Output format',
            enum: ['mp3', 'wav', 'opus'],
          },
        },
        required: ['text'],
      },
    });

    this.registerTool({
      name: 'audio.stt',
      description: 'Transcribe audio to text',
      category: 'audio',
      operations: ['audio.stt'],
      inputSchema: {
        type: 'object',
        properties: {
          artifact_id: { type: 'string', description: 'ID of the audio file' },
          language: { type: 'string', description: 'Language code (optional)' },
          diarize: { type: 'boolean', description: 'Enable speaker diarization', default: false },
        },
        required: ['artifact_id'],
      },
    });

    this.registerTool({
      name: 'audio.diarize',
      description: 'Identify speakers in audio',
      category: 'audio',
      operations: ['audio.diarize'],
      inputSchema: {
        type: 'object',
        properties: {
          artifact_id: { type: 'string', description: 'ID of the audio file' },
          num_speakers: { type: 'number', description: 'Expected number of speakers' },
        },
        required: ['artifact_id'],
      },
    });

    this.registerTool({
      name: 'audio.isolate',
      description: 'Isolate specific audio stems',
      category: 'audio',
      operations: ['audio.isolate'],
      inputSchema: {
        type: 'object',
        properties: {
          artifact_id: { type: 'string', description: 'ID of the audio file' },
          target: {
            type: 'string',
            description: 'Stem to isolate',
            enum: ['vocals', 'instruments', 'drums', 'bass'],
          },
        },
        required: ['artifact_id', 'target'],
      },
    });

    this.registerTool({
      name: 'audio.music',
      description: 'Generate music from a text prompt',
      category: 'audio',
      operations: ['audio.music'],
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Text description of the music to generate' },
          duration: { type: 'number', description: 'Duration in seconds', default: 30 },
          instrumental: {
            type: 'boolean',
            description: 'Generate instrumental only',
            default: true,
          },
          style: { type: 'string', description: 'Musical style (e.g., pop, rock, classical)' },
          tempo: { type: 'number', description: 'BPM tempo' },
          format: {
            type: 'string',
            description: 'Output format',
            enum: ['mp3', 'wav', 'ogg'],
            default: 'mp3',
          },
        },
        required: ['prompt'],
      },
    });

    this.registerTool({
      name: 'audio.sound_effect',
      description: 'Generate a sound effect from a text prompt',
      category: 'audio',
      operations: ['audio.sound_effect'],
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Text description of the sound effect' },
          duration: { type: 'number', description: 'Duration in seconds', default: 5 },
          format: {
            type: 'string',
            description: 'Output format',
            enum: ['mp3', 'wav', 'ogg'],
            default: 'mp3',
          },
        },
        required: ['prompt'],
      },
    });

    // Video operations
    this.registerTool({
      name: 'video.generate',
      description: 'Generate a video from a text prompt',
      category: 'video',
      operations: ['video.generate'],
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Text description of the video' },
          duration: { type: 'number', description: 'Duration in seconds', default: 5 },
          aspect_ratio: { type: 'string', description: 'Aspect ratio' },
          style: { type: 'string', description: 'Video style' },
        },
        required: ['prompt'],
      },
    });

    this.registerTool({
      name: 'video.image_to_video',
      description: 'Animate an image into a video',
      category: 'video',
      operations: ['video.image_to_video'],
      inputSchema: {
        type: 'object',
        properties: {
          artifact_id: { type: 'string', description: 'ID of the source image' },
          motion_prompt: { type: 'string', description: 'Description of motion' },
          duration: { type: 'number', description: 'Duration in seconds', default: 5 },
        },
        required: ['artifact_id'],
      },
    });

    this.registerTool({
      name: 'video.extract_frames',
      description: 'Extract frames from a video',
      category: 'video',
      operations: ['video.extract_frames'],
      inputSchema: {
        type: 'object',
        properties: {
          artifact_id: { type: 'string', description: 'ID of the video' },
          interval: { type: 'number', description: 'Extract every Nth frame', default: 30 },
          timestamps: {
            type: 'array',
            items: { type: 'number' },
            description: 'Specific timestamps in seconds',
          },
        },
        required: ['artifact_id'],
      },
    });

    this.registerTool({
      name: 'video.extract_audio',
      description: 'Extract audio track from a video',
      category: 'video',
      operations: ['video.extract_audio'],
      inputSchema: {
        type: 'object',
        properties: {
          artifact_id: { type: 'string', description: 'ID of the video' },
          format: {
            type: 'string',
            description: 'Audio format',
            enum: ['mp3', 'wav', 'aac'],
            default: 'mp3',
          },
        },
        required: ['artifact_id'],
      },
    });

    // Document operations
    this.registerTool({
      name: 'document.ocr',
      description: 'Extract text from document images',
      category: 'document',
      operations: ['document.ocr'],
      inputSchema: {
        type: 'object',
        properties: {
          artifact_id: { type: 'string', description: 'ID of the document image or PDF' },
          output_format: {
            type: 'string',
            description: 'Output format',
            enum: ['plain_text', 'structured_json', 'markdown'],
          },
        },
        required: ['artifact_id'],
      },
    });

    this.registerTool({
      name: 'document.extract_tables',
      description: 'Extract tables from documents',
      category: 'document',
      operations: ['document.extract_tables'],
      inputSchema: {
        type: 'object',
        properties: {
          artifact_id: { type: 'string', description: 'ID of the document image or PDF' },
          output_format: {
            type: 'string',
            description: 'Output format',
            enum: ['markdown', 'json'],
          },
        },
        required: ['artifact_id'],
      },
    });

    this.registerTool({
      name: 'document.extract_fields',
      description: 'Extract structured fields from documents',
      category: 'document',
      operations: ['document.extract_fields'],
      inputSchema: {
        type: 'object',
        properties: {
          artifact_id: { type: 'string', description: 'ID of the document image or PDF' },
          field_schema: {
            type: 'object',
            description: 'Schema of fields to extract',
            additionalProperties: { type: 'string' },
          },
        },
        required: ['artifact_id', 'field_schema'],
      },
    });

    this.registerTool({
      name: 'document.summarize',
      description: 'Summarize document content',
      category: 'document',
      operations: ['document.summarize'],
      inputSchema: {
        type: 'object',
        properties: {
          artifact_id: { type: 'string', description: 'ID of the document' },
          length: {
            type: 'string',
            description: 'Summary length',
            enum: ['short', 'medium', 'long', 'detailed'],
          },
          style: { type: 'string', description: 'Summary style', default: 'neutral' },
        },
        required: ['artifact_id'],
      },
    });

    // Quality gate evaluation tool
    this.registerTool({
      name: 'quality_gate.evaluate',
      description: 'Evaluate an artifact against a quality gate configuration',
      category: 'pipeline',
      operations: [],
      inputSchema: {
        type: 'object',
        properties: {
          artifact_id: { type: 'string', description: 'ID of the artifact to evaluate' },
          gate: {
            type: 'object',
            description: 'Quality gate configuration',
            properties: {
              type: {
                type: 'string',
                description: 'Gate type',
                enum: ['threshold', 'dimension-check', 'llm-judge', 'custom'],
              },
              config: { type: 'object', description: 'Gate-specific configuration' },
              action: {
                type: 'string',
                description: 'Action on failure',
                enum: ['fail', 'retry', 'warn'],
                default: 'fail',
              },
            },
            required: ['type', 'config'],
          },
        },
        required: ['artifact_id', 'gate'],
      },
    });

    // Cost operation (already exists but registering for completeness)
    this.registerTool({
      name: 'media.costs.summary',
      description: 'Get running cost totals',
      category: 'cost',
      operations: [],
      inputSchema: {
        type: 'object',
        properties: {},
      },
    });
  }

  private registerTool(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);

    for (const operation of tool.operations) {
      this.operationToTool.set(operation, tool.name);
    }
  }

  getTool(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  getToolForOperation(operation: string): ToolDefinition | undefined {
    const toolName = this.operationToTool.get(operation);
    return toolName ? this.tools.get(toolName) : undefined;
  }

  getAllTools(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  getToolsByCategory(category: string): ToolDefinition[] {
    return Array.from(this.tools.values()).filter((t) => t.category === category);
  }

  getSupportedOperations(): string[] {
    return Array.from(this.operationToTool.keys());
  }

  toMCPTools(): Tool[] {
    return this.getAllTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Tool['inputSchema'],
    }));
  }

  isOperationSupported(operation: string): boolean {
    return this.operationToTool.has(operation);
  }

  validateInput(
    toolName: string,
    input: Record<string, unknown>
  ): { valid: boolean; errors: string[] } {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return { valid: false, errors: [`Unknown tool: ${toolName}`] };
    }

    const schema = tool.inputSchema;
    const errors: string[] = [];

    // Check required fields
    const required = schema.required as string[] | undefined;
    if (required) {
      for (const field of required) {
        if (input[field] === undefined || input[field] === null || input[field] === '') {
          errors.push(`Missing required field: ${field}`);
        }
      }
    }

    // Type checking for provided fields
    const properties = schema.properties as
      | Record<string, { type?: string; enum?: string[] }>
      | undefined;
    if (properties) {
      for (const [key, value] of Object.entries(input)) {
        const prop = properties[key];
        if (prop) {
          // Type validation
          if (prop.type === 'string' && typeof value !== 'string') {
            errors.push(`Field '${key}' must be a string`);
          } else if (prop.type === 'number' && typeof value !== 'number') {
            errors.push(`Field '${key}' must be a number`);
          } else if (prop.type === 'boolean' && typeof value !== 'boolean') {
            errors.push(`Field '${key}' must be a boolean`);
          } else if (prop.type === 'array' && !Array.isArray(value)) {
            errors.push(`Field '${key}' must be an array`);
          }
          // Enum validation
          if (prop.enum && !prop.enum.includes(value as string)) {
            errors.push(`Field '${key}' must be one of: ${prop.enum.join(', ')}`);
          }
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }
}

export const toolRegistry = new ToolRegistry();
