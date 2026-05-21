/**
 * Example: Voice & Style Narration with Burned Captions
 *
 * Demonstrates pipeline-level context for voice/style references (F13),
 * loudness normalization (F14), and burned-in captions (F12).
 *
 * Defines a narrator voice and hero visual style at pipeline scope,
 * reuses them via { $ref } syntax across steps, and produces a
 * final video with normalized audio and burned-in subtitles.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function voiceStyleNarration() {
  const client = new Client(
    { name: 'example-voice-style', version: '1.0.0' },
    { capabilities: {} },
  );

  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:8080'));
  await client.connect(transport);

  console.log('Connected to media-pipeline-mcp server\n');

  // Pipeline with run context: voices and styles are defined once at the
  // top level and referenced by individual steps via { $ref }.
  const pipelineDefinition = {
    id: 'voice-style-narration-demo',
    context: {
      voices: {
        narrator: {
          provider: 'elevenlabs',
          voiceId: 'ABCD1234',
          settings: { speed: 1.0, stability: 0.7 },
        },
      },
      styles: {
        hero: {
          description: 'cinematic, golden hour, shallow depth of field',
          negative: 'flat, dull, boring',
        },
      },
    },
    steps: [
      {
        id: 'step1',
        operation: 'audio.tts',
        inputs: {
          text: 'In the golden hour light, the landscape transformed into a breathtaking tapestry of color and shadow.',
          voice: { $ref: { kind: 'voice', name: 'narrator' } },
        },
        config: {
          output_format: 'mp3',
        },
      },
      {
        id: 'step2',
        operation: 'image.generate',
        inputs: {
          prompt: 'A majestic mountain range at sunset with golden light sweeping across the peaks',
          style: { $ref: { kind: 'style', name: 'hero' } },
        },
        config: {
          model: 'sd3',
          dimensions: '1920x1080',
        },
        gates: [
          {
            type: 'loudness',
            preset: 'podcast',
            action: 'normalize',
          },
        ],
      },
      {
        id: 'step3',
        operation: 'video.subtitle',
        inputs: {
          artifact_id: 'pre-uploaded-video-001',
        },
        config: {
          language: 'en',
          format: 'srt',
          burnIn: {
            fontSize: 28,
            position: 'bottom',
            font: 'Arial',
            fontColor: '#FFFFFF',
          },
        },
      },
    ],
  };

  // Step 1: Define and validate the pipeline
  console.log('--- Step 1: Define and validate pipeline ---');
  const defineResult = await client.callTool({
    name: 'media.pipeline.define',
    arguments: {
      pipeline: pipelineDefinition,
    },
  });
  console.log('Pipeline definition result:', JSON.stringify(defineResult, null, 2));
  console.log('');

  if (defineResult.isError) {
    console.error('Pipeline validation failed');
    await client.close();
    return;
  }

  // Step 2: Execute the pipeline
  console.log('--- Step 2: Execute pipeline ---');
  const runResult = await client.callTool({
    name: 'media.pipeline.run',
    arguments: {
      pipeline: pipelineDefinition,
    },
  });
  console.log('Pipeline execution result:', JSON.stringify(runResult, null, 2));
  console.log('');

  // Step 3: Print artifact IDs from the result
  console.log('--- Step 3: Output artifacts ---');
  if (runResult.artifacts) {
    for (const artifact of runResult.artifacts) {
      console.log(`Artifact: ${artifact.id} (${artifact.type}) — step ${artifact.sourceStep}`);
      console.log(`  URI: ${artifact.uri}`);
    }
  }

  // Step 4: Cost breakdown
  console.log('\n--- Step 4: Cost breakdown ---');
  console.log(`Total cost: $${(runResult.cost_usd || 0).toFixed(4)}`);
  console.log(`Duration: ${runResult.duration_ms || 0}ms`);

  await client.close();
  console.log('\nDisconnected from server');
}

voiceStyleNarration().catch(console.error);
