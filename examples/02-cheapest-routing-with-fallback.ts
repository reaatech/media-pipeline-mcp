/**
 * Example: Cheapest Routing with Fallback
 *
 * Demonstrates F8 (routing) and F2 (cache) by running an image.generate step
 * with a route config that selects the cheapest healthy provider from three
 * candidates. The second run with identical params should hit the content cache.
 *
 * Requires: FEATURE_ROUTING=true and FEATURE_CONTENT_CACHE=true (set on the server).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function cheapestRoutingWithFallback() {
  const client = new Client(
    { name: 'example-cheapest-routing', version: '1.0.0' },
    { capabilities: {} },
  );

  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:8080'));
  await client.connect(transport);

  console.log('Connected to media-pipeline-mcp server\n');

  // Define a pipeline with route-based provider selection and content cache
  const pipelineDefinition = {
    id: 'cheapest-routing-demo',
    steps: [
      {
        id: 'generate',
        operation: 'image.generate',
        inputs: {
          prompt: 'A serene mountain landscape at sunset, photorealistic, 4K',
        },
        config: {
          dimensions: '1024x1024',
          negative_prompt: 'blurry, low quality, watermark',
        },
        route: {
          strategy: 'cheapest-acceptable',
          candidates: [
            { provider: 'fal', model: 'flux-pro-1.1', maxQueueMs: 30000 },
            { provider: 'stability', model: 'sd3-medium', maxUsd: 0.05 },
            { provider: 'replicate', model: 'sdxl' },
          ],
        },
        cache: {
          mode: 'use',
          ttlSeconds: 3600,
        },
      },
    ],
  };

  // Step 1: Define and validate
  console.log('--- Step 1: Define and validate pipeline ---');
  const defineResult = await client.callTool({
    name: 'media.pipeline.define',
    arguments: {
      pipeline: pipelineDefinition,
    },
  });
  console.log('Validation:', JSON.stringify(defineResult, null, 2));
  console.log('');

  if (defineResult.isError) {
    console.error('Pipeline validation failed:', defineResult);
    await client.close();
    return;
  }

  // Step 2: Execute the pipeline (first run — router picks cheapest healthy)
  console.log('--- Step 2: Execute pipeline (first run) ---');
  const runResult = await client.callTool({
    name: 'media.pipeline.run',
    arguments: {
      pipeline: pipelineDefinition,
    },
  });
  console.log('First run result:', JSON.stringify(runResult, null, 2));

  if (runResult.status === 'completed') {
    console.log('\nFirst run completed:');
    console.log(`  Cost: $${runResult.cost_usd?.toFixed(4) || '0.0000'}`);
    console.log(`  Duration: ${runResult.duration_ms || 0}ms`);
    if (runResult.artifacts) {
      for (const a of runResult.artifacts) {
        console.log(`  Artifact: ${a.id} (${a.type}) via ${a.sourceStep}`);
      }
    }
  }
  console.log('');

  // Step 3: Execute the same pipeline again — expect cache hit ($0 cost)
  console.log('--- Step 3: Execute same pipeline (second run — cache hit) ---');
  const secondRun = await client.callTool({
    name: 'media.pipeline.run',
    arguments: {
      pipeline: pipelineDefinition,
    },
  });
  console.log('Second run result:', JSON.stringify(secondRun, null, 2));

  const cost = secondRun.cost_usd ?? -1;
  if (cost === 0) {
    console.log('\n✓ Cache hit — cost rebated to $0.00');
  } else if (cost > 0) {
    console.log(`\nSecond run cost: $${cost.toFixed(4)} (cache not available or missed)`);
  } else {
    console.log('\nCost info not available in response');
  }

  await client.close();
  console.log('\nDisconnected from server');
}

cheapestRoutingWithFallback().catch(console.error);
