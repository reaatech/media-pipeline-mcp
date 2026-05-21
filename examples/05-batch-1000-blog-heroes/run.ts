/**
 * Example: Batch Blog Hero Images
 *
 * Demonstrates batch pipeline execution (F15) with per-row idempotency (F1)
 * and per-run budget caps (F4). Reads blog post metadata from a CSV, generates
 * a hero image for each row, and produces a JSONL report artifact.
 *
 * Run: npx tsx examples/05-batch-1000-blog-heroes/run.ts
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function batchBlogHeroes() {
  const client = new Client(
    { name: 'example-batch-blog-heroes', version: '1.0.0' },
    { capabilities: {} },
  );

  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:8080'));
  await client.connect(transport);

  console.log('Connected to media-pipeline-mcp server\n');

  // Step 1: Start the batch
  console.log('--- Step 1: Start batch ---');
  const batchResult = await client.callTool({
    name: 'media.pipeline.batch',
    arguments: {
      source: {
        type: 'csv',
        uri: 'file://blog-posts.csv',
      },
      pipeline: {
        id: 'blog-heroes',
        steps: [
          {
            id: 'gen',
            operation: 'image.generate',
            inputs: {
              prompt: 'hero image for {{headline}} on {{topic}}',
            },
            config: {
              dimensions: '1024x1024',
              model: 'sd3',
            },
          },
          {
            id: 'upscale',
            operation: 'image.upscale',
            inputs: {
              artifact_id: '{{gen.output}}',
            },
            config: {
              scale: '2x',
            },
          },
        ],
      },
      concurrency: 5,
      onRowFailure: 'continue',
      perRunBudget: {
        maxUsd: 0.2,
        onExceed: 'abort',
      },
      idempotencyKey: `batch-blog-heroes-${Date.now()}`,
    },
  });

  console.log('Batch result:', JSON.stringify(batchResult, null, 2));
  console.log('');

  if (!batchResult.batchId) {
    console.error('Batch did not return a batchId');
    await client.close();
    return;
  }

  const batchId = batchResult.batchId as string;

  // Step 2: Poll until terminal (max 30s)
  console.log('--- Step 2: Poll for completion ---');
  const pollLimit = Date.now() + 30_000;
  interface BatchStatusResult {
    batchId: string;
    status: string;
    totalRows: number;
    completed: number;
    failed: number;
    costUsd: number;
    reportArtifactId?: string;
  }
  let status: BatchStatusResult;

  while (Date.now() < pollLimit) {
    await new Promise((r) => setTimeout(r, 2000));

    status = await client.callTool({
      name: 'media.pipeline.batch.status',
      arguments: { batchId },
    });

    const s = status.status as string;
    console.log(
      `  Batch status: ${s}  (${status.completed}/${status.totalRows} rows, ${status.failed} failed)`,
    );

    if (s === 'completed' || s === 'failed' || s === 'cancelled' || s === 'partial') break;
  }

  console.log('');

  if (!status) {
    console.error('Timed out polling batch status');
    await client.close();
    return;
  }

  // Step 3: Print summary
  console.log('--- Step 3: Summary ---');
  console.log(`Batch ID:      ${status.batchId}`);
  console.log(`Status:        ${status.status}`);
  console.log(`Total rows:    ${status.totalRows}`);
  console.log(`Completed:     ${status.completed}`);
  console.log(`Failed:        ${status.failed}`);
  console.log(`Cost:          $${(status.costUsd as number)?.toFixed(4) || '0.0000'}`);
  if (status.reportArtifactId) {
    console.log(`Report:        ${status.reportArtifactId} (JSONL)`);
  }
  console.log('');

  // Step 4: Retry failed rows
  if ((status.failed as number) > 0) {
    console.log('--- Step 4: Retry failed rows ---');
    const retryResult = await client.callTool({
      name: 'media.pipeline.batch.retry',
      arguments: {
        batchId,
        onlyFailed: true,
      },
    });
    console.log('Retry result:', JSON.stringify(retryResult, null, 2));
    console.log('');
  } else {
    console.log('--- Step 4: No failed rows to retry ---\n');
  }

  await client.close();
  console.log('Disconnected from server');
}

batchBlogHeroes().catch(console.error);
