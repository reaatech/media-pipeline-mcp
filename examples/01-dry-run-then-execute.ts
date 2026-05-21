/**
 * Example: Dry-Run → Execute with Budget Caps
 *
 * Demonstrates F4 (budget caps) and F5 (pipeline.estimate).
 * Callers can preview a pipeline's cost band before paying for it,
 * set a hard cap, and have the executor abort mid-run if the cap is crossed.
 *
 * Builds a 4-step pipeline, estimates it, runs with a generous cap,
 * then re-runs with a deliberately low cap to show BUDGET_EXCEEDED.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function dryRunThenExecute() {
  const client = new Client(
    { name: 'example-dry-run-execute', version: '1.0.0' },
    { capabilities: {} },
  );

  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:8080'));
  await client.connect(transport);

  console.log('Connected to media-pipeline-mcp server\n');

  // ── 4-step pipeline ────────────────────────────────────────────────
  const pipelineDefinition = {
    id: 'dry-run-execute-demo',
    steps: [
      {
        id: 'step1',
        operation: 'image.generate',
        inputs: {
          prompt: 'A serene mountain lake at sunrise, mist rising, photorealistic',
        },
        config: {
          model: 'sd3',
          dimensions: '1024x1024',
          negative_prompt: 'blurry, low quality, watermark',
        },
      },
      {
        id: 'step2',
        operation: 'image.upscale',
        inputs: {
          artifact_id: '{{step1.output}}',
        },
        config: {
          scale: '4x',
          model: 'real-esrgan',
        },
      },
      {
        id: 'step3',
        operation: 'image.describe',
        inputs: {
          artifact_id: '{{step2.output}}',
        },
        config: {
          detail: 'detailed',
        },
      },
      {
        id: 'step4',
        operation: 'image.resize',
        inputs: {
          artifact_id: '{{step2.output}}',
        },
        config: {
          dimensions: '800x600',
          fit: 'cover',
        },
      },
    ],
  };

  // ── Part 1: Estimate ───────────────────────────────────────────────
  console.log('--- Part 1: Estimate pipeline cost ---');
  const estimateResult = await client.callTool({
    name: 'media.pipeline.estimate',
    arguments: {
      pipeline: pipelineDefinition,
    },
  });
  console.log('Estimate result:', JSON.stringify(estimateResult, null, 2));
  console.log('');

  // ── Part 2: Run with a generous cap ────────────────────────────────
  console.log('--- Part 2: Run with budget cap $0.20 ---');
  const runWithCap = await client.callTool({
    name: 'media.pipeline.run',
    arguments: {
      pipeline: {
        ...pipelineDefinition,
        budget: { maxUsd: 0.2, onExceed: 'abort' },
      },
    },
  });
  console.log('Pipeline result:', JSON.stringify(runWithCap, null, 2));
  console.log('');

  if (runWithCap.status === 'completed') {
    console.log('✓ Pipeline completed within budget');
    if (runWithCap.cost_usd !== undefined) {
      console.log(`  Actual cost: $${runWithCap.cost_usd.toFixed(4)}`);
    }
  } else {
    console.log(`⚠ Pipeline ended with status: ${runWithCap.status}`);
  }
  console.log('');

  // ── Part 3: Re-run with a deliberately low cap ─────────────────────
  console.log('--- Part 3: Re-run with budget cap $0.01 (expect abort) ---');
  const runLowCap = await client.callTool({
    name: 'media.pipeline.run',
    arguments: {
      pipeline: {
        ...pipelineDefinition,
        budget: { maxUsd: 0.01, onExceed: 'abort' },
      },
    },
  });
  console.log('Pipeline result:', JSON.stringify(runLowCap, null, 2));
  console.log('');

  if (runLowCap.status === 'failed') {
    console.log('✓ Budget exceeded — pipeline correctly aborted');
  } else {
    console.log(`⚠ Unexpected status: ${runLowCap.status}`);
  }

  await client.close();
  console.log('\nDisconnected from server');
}

dryRunThenExecute().catch(console.error);
