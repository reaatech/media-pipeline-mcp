/**
 * Example: A/B Variants with LLM-Judge & Rule-Judge
 *
 * Demonstrates F9 (variants) and F2 (cache).
 * The executor fans out N image variants in parallel, runs a judge
 * against them, archives the losers, and surfaces the winner.
 *
 * First run uses an llm-judge; second run uses a rule-judge
 * that requires no LLM call. Both runs also demonstrate F2
 * step-level cache dedup.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function abVariantsWithJudge() {
  const client = new Client(
    { name: 'example-ab-variants', version: '1.0.0' },
    { capabilities: {} },
  );

  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:8080'));
  await client.connect(transport);

  console.log('Connected to media-pipeline-mcp server\n');

  // ── Part 1: LLM-Judge variants ─────────────────────────────────────
  console.log('--- Part 1: A/B variants with LLM-Judge ---');

  const llmPipeline = {
    id: 'ab-variants-llm-demo',
    steps: [
      {
        id: 'generate',
        operation: 'image.generate',
        inputs: {
          prompt: 'A futuristic city skyline at night with neon lights reflecting on wet streets',
        },
        config: {
          model: 'sd3',
          dimensions: '1024x1024',
          negative_prompt: 'blurry, low quality, oversaturated',
        },
        variants: {
          n: 4,
          seedStrategy: 'sequential' as const,
          judge: {
            type: 'llm-judge' as const,
            criteria: 'best matches the prompt with no compositional errors',
            model: 'claude-sonnet-4-6',
          },
          loserAction: 'archive' as const,
        },
        cache: {
          mode: 'dedup',
          ttlSeconds: 3600,
        },
      },
    ],
  };

  const llmResult = await client.callTool({
    name: 'media.pipeline.run',
    arguments: {
      pipeline: llmPipeline,
    },
  });
  console.log('LLM-Judge pipeline result:', JSON.stringify(llmResult, null, 2));
  console.log('');

  if (llmResult.success) {
    console.log('✓ LLM-Judge variants completed — winner artifact selected');
    if (llmResult.artifacts) {
      for (const art of llmResult.artifacts) {
        console.log(`  Artifact: ${art.id} (${art.type}) — ${art.sourceStep}`);
      }
    }
    const cost = llmResult.cost_usd ?? 0;
    const runnerUpCount = (llmResult.artifacts?.length ?? 1) - 1;
    console.log(`  Winner + ${runnerUpCount} archived losers`);
    console.log(`  Total cost: $${cost.toFixed(4)}`);
  } else {
    console.log(`⚠ LLM-Judge pipeline status: ${llmResult.status}`);
  }
  console.log('');

  // ── Part 2: Rule-Judge variants (no LLM needed) ────────────────────
  console.log('--- Part 2: A/B variants with Rule-Judge (no LLM) ---');

  const rulePipeline = {
    id: 'ab-variants-rule-demo',
    steps: [
      {
        id: 'generate',
        operation: 'image.generate',
        inputs: {
          prompt: 'A minimalist logo design for a tech company, clean lines',
        },
        config: {
          model: 'sd3',
          dimensions: '1024x1024',
        },
        variants: {
          n: 4,
          seedStrategy: 'sequential' as const,
          judge: {
            type: 'rule' as const,
            expression: 'metadata.width >= 1024',
          },
          minScore: 1,
          loserAction: 'discard' as const,
        },
      },
    ],
  };

  const ruleResult = await client.callTool({
    name: 'media.pipeline.run',
    arguments: {
      pipeline: rulePipeline,
    },
  });
  console.log('Rule-Judge pipeline result:', JSON.stringify(ruleResult, null, 2));
  console.log('');

  if (ruleResult.success) {
    console.log('✓ Rule-Judge variants completed — no LLM call required');
    if (ruleResult.artifacts) {
      for (const art of ruleResult.artifacts) {
        console.log(`  Artifact: ${art.id} (${art.type}) — ${art.sourceStep}`);
      }
    }
  } else {
    console.log(`⚠ Rule-Judge pipeline status: ${ruleResult.status}`);
  }

  await client.close();
  console.log('\nDisconnected from server');
}

abVariantsWithJudge().catch(console.error);
