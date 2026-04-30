/**
 * Example: Product Photo Pipeline
 *
 * Demonstrates the product-photo template pipeline:
 * generate → upscale → remove background → composite onto lifestyle background
 *
 * Shows quality gate rejection and retry behavior.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function productPhotoPipeline() {
  const client = new Client(
    { name: 'example-product-photo', version: '1.0.0' },
    { capabilities: {} },
  );

  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:8080'));
  await client.connect(transport);

  console.log('Connected to media-pipeline-mcp server\n');

  // Define the product photo pipeline
  const pipelineDefinition = {
    id: 'product-photo-demo',
    steps: [
      {
        id: 'generate',
        operation: 'image.generate',
        inputs: {
          prompt:
            'Professional product photo of a white ceramic coffee mug on a clean white background, studio lighting, high quality',
        },
        config: {
          model: 'sd3',
          dimensions: '1024x1024',
          negative_prompt: 'blurry, low quality, watermark, text',
        },
        qualityGate: {
          type: 'threshold',
          config: {
            checks: [
              { field: 'metadata.width', operator: '>=', value: 1024 },
              { field: 'metadata.height', operator: '>=', value: 1024 },
            ],
          },
          action: 'retry',
          maxRetries: 2,
        },
      },
      {
        id: 'upscale',
        operation: 'image.upscale',
        inputs: {
          artifact_id: '{{generate.output}}',
        },
        config: {
          scale: '4x',
          model: 'real-esrgan',
        },
      },
      {
        id: 'remove_bg',
        operation: 'image.remove_background',
        inputs: {
          artifact_id: '{{upscale.output}}',
        },
      },
      {
        id: 'composite',
        operation: 'image.composite',
        inputs: {
          base_artifact_id: '{{remove_bg.output}}',
          overlay_artifact_id: 'lifestyle-bg-001', // Pre-existing background
        },
        config: {
          position: 'center',
          blend_mode: 'normal',
          opacity: 1.0,
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
productPhotoPipeline().catch(console.error);
