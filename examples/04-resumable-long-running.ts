/**
 * Example: Resumable Long-Running Pipeline
 *
 * Demonstrates a multi-step pipeline that fails mid-run and can be resumed
 * without re-paying for completed steps (F1 idempotency, F3 resume, F7 webhook resume).
 *
 * Steps 1-2 succeed, step 3 fails due to a quality gate (maxRetries: 0),
 * then resume retries step 3 and lets steps 4-5 run normally.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function resumableLongRunning() {
  const client = new Client({ name: 'example-resumable', version: '1.0.0' }, { capabilities: {} });

  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:8080'));
  await client.connect(transport);

  console.log('Connected to media-pipeline-mcp server\n');

  // Define a 5-step pipeline where step 3 has a hard quality gate that fails
  // on the first attempt (maxRetries: 0).
  const pipelineDefinition = {
    id: 'resumable-demo',
    resumable: true,
    steps: [
      {
        id: 'step1',
        operation: 'image.generate',
        inputs: {
          prompt: 'A serene mountain lake at sunrise, photorealistic',
        },
        config: {
          model: 'sd3',
          dimensions: '1024x1024',
          negative_prompt: 'blurry, low quality',
        },
      },
      {
        id: 'step2',
        operation: 'image.upscale',
        inputs: {
          artifact_id: '{{step1.output}}',
        },
        config: {
          scale: '2x',
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
          detail_level: 'detailed',
        },
        qualityGate: {
          type: 'threshold',
          config: {
            checks: [{ field: 'metadata.width', operator: '>=', value: 99999 }],
          },
          action: 'retry',
          maxRetries: 0,
        },
      },
      {
        id: 'step4',
        operation: 'audio.tts',
        inputs: {
          text: '{{step3.output}}',
          voice: 'default',
        },
        config: {
          speed: 1.0,
          output_format: 'mp3',
        },
      },
      {
        id: 'step5',
        operation: 'image.resize',
        inputs: {
          artifact_id: '{{step2.output}}',
        },
        config: {
          dimensions: '512x512',
          fit: 'contain',
        },
      },
    ],
  };

  // Phase 1: Initial run (expects failure at step 3)
  console.log('--- Phase 1: Initial run (expects failure) ---');
  const runResult = await client.callTool({
    name: 'media.pipeline.run',
    arguments: {
      pipeline: pipelineDefinition,
    },
  });
  console.log('Run result:', JSON.stringify(runResult, null, 2));
  console.log('');

  const status = runResult.status || 'unknown';
  const pipelineId = runResult.pipeline_id || 'unknown';
  // Use the returned pipeline_id as the run identifier for status checks
  const runId = runResult.runId || pipelineId;
  console.log(`Pipeline: ${pipelineId}, Status: ${status}`);
  console.log(`Run ID: ${runId}\n`);

  if (status === 'completed') {
    console.log('Pipeline completed unexpectedly — nothing to resume.\n');
    await client.close();
    return;
  }

  // Phase 2: Poll status (optional, for demonstration)
  console.log('--- Phase 2: Check pipeline status ---');
  const statusResult = await client.callTool({
    name: 'media.pipeline.status',
    arguments: {
      pipeline_id: pipelineId,
    },
  });
  console.log('Status result:', JSON.stringify(statusResult, null, 2));
  console.log('');

  // Phase 3: Resume — steps 1-2 load cached artifacts, step 3 retries and
  // succeeds, steps 4-5 run fresh.
  console.log('--- Phase 3: Resume pipeline ---');
  const resumeResult = await client.callTool({
    name: 'media.pipeline.resume',
    arguments: {
      runId: runId,
    },
  });
  console.log('Resume result:', JSON.stringify(resumeResult, null, 2));
  console.log('');

  // Phase 4: Final status check
  console.log('--- Phase 4: Final artifacts ---');
  const finalResult = await client.callTool({
    name: 'media.pipeline.status',
    arguments: {
      pipeline_id: pipelineId,
    },
  });
  console.log('Final status:', JSON.stringify(finalResult, null, 2));

  if (finalResult.artifacts) {
    for (const artifact of finalResult.artifacts) {
      console.log(`  Artifact: ${artifact.id} (${artifact.type}) — step ${artifact.sourceStep}`);
    }
  }

  await client.close();
  console.log('\nDisconnected from server');
}

resumableLongRunning().catch(console.error);
