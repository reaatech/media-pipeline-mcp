/**
 * Example: Aspect Ratio Fan-out
 *
 * Demonstrates F11 (ratios): the same prompt produces 1:1 (Instagram),
 * 9:16 (Stories/TikTok), and 16:9 (YouTube) outputs in one step.
 * Shows native vs cropped/padded source modes.
 *
 * Run: npx tsx examples/06-aspect-ratio-fanout.ts
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function aspectRatioFanout() {
  const client = new Client(
    { name: 'example-aspect-ratio-fanout', version: '1.0.0' },
    { capabilities: {} },
  );

  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:8080'));
  await client.connect(transport);

  console.log('Connected to media-pipeline-mcp server\n');

  // Pass 1: Smart-crop fallback, face-aware
  console.log('--- Pass 1: Smart-crop fallback (face-aware) ---');
  const pass1Pipeline = {
    id: 'ratio-fanout-pass1',
    steps: [
      {
        id: 'gen',
        operation: 'image.generate',
        inputs: {
          prompt:
            'Professional headshot of a software engineer in a modern open office, natural lighting, smiling',
        },
        config: {
          model: 'sd3',
          negative_prompt: 'blurry, low quality, watermark',
          ratios: {
            ratios: ['1:1', '9:16', '16:9'],
            fallback: 'smart-crop',
            faceAware: true,
          },
        },
      },
    ],
  };

  const pass1Result = await client.callTool({
    name: 'media.pipeline.run',
    arguments: { pipeline: pass1Pipeline },
  });

  console.log('Execution result:', JSON.stringify(pass1Result, null, 2));
  console.log('');

  // Print variants from the artifact metadata if available
  if (pass1Result.artifacts) {
    console.log('Variants:');
    for (const artifact of pass1Result.artifacts) {
      const ratio = artifact.metadata?.ratio || 'unknown';
      const source = artifact.metadata?.source || 'native';
      console.log(`  ${ratio} — source: ${source} — ${artifact.id}`);
    }
  } else if (pass1Result.variants) {
    console.log('Variants:');
    for (const v of pass1Result.variants) {
      console.log(`  ${v.ratio} — source: ${v.source} — ${v.artifactId}`);
    }
  }
  console.log('');

  // Pass 2: Pad fallback with brand colour
  console.log('--- Pass 2: Pad fallback (#FF6B35) ---');
  const pass2Pipeline = {
    id: 'ratio-fanout-pass2',
    steps: [
      {
        id: 'gen',
        operation: 'image.generate',
        inputs: {
          prompt:
            'Banner graphic for a tech conference, bold typography, geometric shapes, blue background',
        },
        config: {
          model: 'sd3',
          negative_prompt: 'blurry, low quality, text',
          ratios: {
            ratios: ['1:1', '9:16', '16:9'],
            fallback: 'pad',
            padColor: '#FF6B35',
            faceAware: false,
          },
        },
      },
    ],
  };

  const pass2Result = await client.callTool({
    name: 'media.pipeline.run',
    arguments: { pipeline: pass2Pipeline },
  });

  console.log('Execution result:', JSON.stringify(pass2Result, null, 2));
  console.log('');

  // Print variants
  if (pass2Result.variants) {
    console.log('Variants:');
    for (const v of pass2Result.variants) {
      console.log(`  ${v.ratio} — source: ${v.source} — ${v.artifactId}`);
    }
  }

  await client.close();
  console.log('\nDisconnected from server');
}

aspectRatioFanout().catch(console.error);
