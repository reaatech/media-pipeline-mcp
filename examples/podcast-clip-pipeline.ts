/**
 * Example: Podcast Clip Pipeline
 *
 * Demonstrates the podcast-clip template pipeline:
 * audio extract → STT → summarize → TTS promo voiceover
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function podcastClipPipeline() {
  const client = new Client(
    { name: 'example-podcast-clip', version: '1.0.0' },
    { capabilities: {} },
  );

  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:8080'));
  await client.connect(transport);

  console.log('Connected to media-pipeline-mcp server\n');

  // Define the podcast clip pipeline
  const pipelineDefinition = {
    id: 'podcast-clip-demo',
    steps: [
      {
        id: 'transcribe',
        operation: 'audio.stt',
        inputs: {
          artifact_id: 'podcast-episode-001', // Pre-uploaded audio file
        },
        config: {
          language: 'en',
          diarize: true,
        },
      },
      {
        id: 'diarize',
        operation: 'audio.diarize',
        inputs: {
          artifact_id: 'podcast-episode-001',
        },
        config: {
          num_speakers: 2,
        },
      },
      {
        id: 'isolate_vocals',
        operation: 'audio.isolate',
        inputs: {
          artifact_id: 'podcast-episode-001',
        },
        config: {
          target: 'vocals',
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
    console.error('Pipeline validation failed:', defineResult);
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

  // Step 3: Check final artifacts
  console.log('--- Step 3: Final artifacts ---');
  if (runResult.artifacts) {
    for (const artifact of runResult.artifacts) {
      console.log(`Artifact: ${artifact.id} (${artifact.type})`);
      console.log(`  URI: ${artifact.uri}`);
      console.log(`  Source: ${artifact.sourceStep}`);
    }
  }

  // Step 4: Get final cost
  console.log('\n--- Step 4: Cost breakdown ---');
  console.log(`Total cost: $${runResult.cost_usd?.toFixed(4) || '0.0000'}`);
  console.log(`Duration: ${runResult.duration_ms || 0}ms`);

  await client.close();
  console.log('\nDisconnected from server');
}

// Run the example
podcastClipPipeline().catch(console.error);
