import { MediaProvider } from '@reaatech/media-pipeline-mcp-provider-core';
import type {
  ProviderHealth,
  ProviderInput,
  ProviderOutput,
} from '@reaatech/media-pipeline-mcp-provider-core';

export interface OpenAIConfig {
  apiKey: string;
  organization?: string;
  project?: string;
  baseUrl?: string;
}

export class OpenAIProvider extends MediaProvider {
  readonly name = 'openai';
  readonly supportedOperations = ['image.generate', 'image.describe', 'audio.tts', 'audio.stt'];

  private apiKey: string;
  private organization?: string;
  private project?: string;
  private baseUrl: string;

  constructor(config: OpenAIConfig) {
    super();
    this.apiKey = config.apiKey;
    this.organization = config.organization;
    this.project = config.project;
    this.baseUrl = config.baseUrl || 'https://api.openai.com/v1';
  }

  async healthCheck(): Promise<ProviderHealth> {
    const startTime = Date.now();
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: this.getHeaders(),
      });

      if (response.ok) {
        return {
          healthy: true,
          latency: Date.now() - startTime,
        };
      }

      return {
        healthy: false,
        latency: Date.now() - startTime,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    } catch (error) {
      return {
        healthy: false,
        latency: Date.now() - startTime,
        error: (error as Error).message,
      };
    }
  }

  async execute(input: ProviderInput): Promise<ProviderOutput> {
    switch (input.operation) {
      case 'image.generate':
        return this.generateImage(input);
      case 'image.describe':
        return this.describeImage(input);
      case 'audio.tts':
        return this.textToSpeech(input);
      case 'audio.stt':
        return this.speechToText(input);
      default:
        throw new Error(`Unsupported operation: ${input.operation}`);
    }
  }

  private async generateImage(input: ProviderInput): Promise<ProviderOutput> {
    const startTime = Date.now();
    const { prompt, size, dimensions, quality, style, style_preset, n, num_outputs } = input.params;
    const requestedSize = (dimensions as string) || (size as string) || '1024x1024';
    const requestedStyle = (style_preset as string) || (style as string) || 'vivid';
    const requestedCount = (num_outputs as number) || (n as number) || 1;

    const response = await fetch(`${this.baseUrl}/images/generations`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model: 'dall-e-3',
        prompt: prompt as string,
        n: requestedCount,
        size: requestedSize,
        quality: (quality as string) || 'standard',
        style: requestedStyle,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI error: ${error}`);
    }

    const result = (await response.json()) as {
      data: Array<{ url: string; revised_prompt: string }>;
    };

    if (!result.data || result.data.length === 0) {
      throw new Error('No image generated');
    }

    // Fetch the actual image
    const imageUrl = result.data[0].url;
    const imageResponse = await fetch(imageUrl);
    const arrayBuffer = await imageResponse.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    return {
      data: buffer,
      mimeType: 'image/png',
      metadata: {
        type: 'image',
        prompt: prompt as string,
        revised_prompt: result.data[0].revised_prompt,
        size: requestedSize,
        model: 'dall-e-3',
      },
      costUsd: 0.04,
      durationMs: Date.now() - startTime,
    };
  }

  private async describeImage(input: ProviderInput): Promise<ProviderOutput> {
    const startTime = Date.now();
    const { artifact_data, mime_type, detail, detail_level } = input.params;
    const effectiveDetail = (detail_level as string) || (detail as string) || 'detailed';
    const describePrompt = this.getDescribePrompt(effectiveDetail);
    const imageMimeType = (mime_type as string) || 'image/png';

    // Use GPT-4 Vision to describe the image
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: describePrompt,
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${imageMimeType};base64,${(artifact_data as Buffer).toString('base64')}`,
                },
              },
            ],
          },
        ],
        max_tokens: 1000,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI error: ${error}`);
    }

    const result = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    const description = result.choices[0].message.content;

    return {
      data: Buffer.from(description),
      mimeType: 'text/plain',
      metadata: {
        type: 'text',
        detail: effectiveDetail,
        model: 'gpt-4o',
      },
      costUsd: 0.01,
      durationMs: Date.now() - startTime,
    };
  }

  private async textToSpeech(input: ProviderInput): Promise<ProviderOutput> {
    const startTime = Date.now();
    const { text, voice, speed, response_format, output_format } = input.params;
    const effectiveFormat = (output_format as string) || (response_format as string) || 'mp3';

    const response = await fetch(`${this.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model: 'tts-1',
        input: text as string,
        voice: (voice as string) || 'alloy',
        speed: (speed as number) || 1.0,
        response_format: effectiveFormat,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI error: ${error}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    return {
      data: buffer,
      mimeType: this.getAudioMimeType(effectiveFormat),
      metadata: {
        type: 'audio',
        voice: voice as string,
        speed: speed as number,
        format: effectiveFormat,
        model: 'tts-1',
      },
      costUsd: 0.015,
      durationMs: Date.now() - startTime,
    };
  }

  private async speechToText(input: ProviderInput): Promise<ProviderOutput> {
    const startTime = Date.now();
    const { audio_data, language } = input.params;

    const formData = new FormData();
    const blob = new Blob([audio_data as Buffer], { type: 'audio/mpeg' });
    formData.append('file', blob, 'audio.mp3');
    formData.append('model', 'whisper-1');
    if (language) {
      formData.append('language', language as string);
    }
    formData.append('response_format', 'verbose_json');

    const response = await fetch(`${this.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI error: ${error}`);
    }

    const result = (await response.json()) as {
      text: string;
      segments?: Array<{ start: number; end: number; text: string }>;
    };

    return {
      data: Buffer.from(JSON.stringify(result, null, 2)),
      mimeType: 'application/json',
      metadata: {
        type: 'text',
        language: language as string,
        model: 'whisper-1',
      },
      costUsd: 0.006,
      durationMs: Date.now() - startTime,
    };
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };

    if (this.organization) {
      headers['OpenAI-Organization'] = this.organization;
    }

    if (this.project) {
      headers['OpenAI-Project'] = this.project;
    }

    return headers;
  }

  private getDescribePrompt(detailLevel: string): string {
    switch (detailLevel) {
      case 'brief':
        return 'Describe this image briefly in 1-2 sentences.';
      case 'structured':
        return 'Describe this image in a structured format covering subject, setting, style, colors, and notable details.';
      default:
        return 'Describe this image in detail.';
    }
  }

  private getAudioMimeType(format: string): string {
    switch (format) {
      case 'wav':
        return 'audio/wav';
      case 'opus':
        return 'audio/opus';
      default:
        return 'audio/mpeg';
    }
  }
}

export function createOpenAIProvider(config: OpenAIConfig): OpenAIProvider {
  return new OpenAIProvider(config);
}
