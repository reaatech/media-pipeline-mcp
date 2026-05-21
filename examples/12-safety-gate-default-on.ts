/**
 * Example: Safety Gate Default-On
 *
 * Demonstrates F16 (safety gate default-on) and its interaction with F9
 * (variants). Proves that even without an explicit gates: [{ type: 'safety' }],
 * the executor injects a moderation gate for moderable operations.
 *
 * Tests:
 *   1. Benign prompt — completes with implicit safety gate passed
 *   2. Hostile prompt — rejected (status: failed, error includes SAFETY_GATE_REJECTED)
 *   3. Same hostile prompt with explicit gates [{ type: 'safety', action: 'warn' }]
 *      — succeeds, proving opt-out works
 *
 * Requires: server with default config (FEATURE_SAFETY_GATE defaults to true)
 * and a wired SafetyClassifier (e.g., OpenAIModerationClassifier).
 * Without a classifier the gate is a silent no-op and all tests pass.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function safetyGateDefaultOn() {
  const client = new Client(
    { name: 'example-safety-gate', version: '1.0.0' },
    { capabilities: {} },
  );

  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:8080'));
  await client.connect(transport);

  console.log('Connected to media-pipeline-mcp server\n');

  // ---------------------------------------------------------------------------
  // Test 1: Benign prompt — implicit safety gate injected, should pass
  // ---------------------------------------------------------------------------
  console.log('--- Test 1: Benign prompt (implicit safety gate) ---');
  const benignPipeline = {
    id: 'safety-benign',
    steps: [
      {
        id: 'generate',
        operation: 'image.generate',
        inputs: {
          prompt: 'A cute kitten playing with a ball of yarn, high quality',
        },
        config: {
          dimensions: '1024x1024',
        },
      },
    ],
  };

  const benignResult = await client.callTool({
    name: 'media.pipeline.run',
    arguments: { pipeline: benignPipeline },
  });
  console.log('Benign result:', JSON.stringify(benignResult, null, 2));

  if (benignResult.status === 'completed') {
    console.log('\n✓ Benign prompt: safety gate passed');
  } else {
    console.log(`\n✗ Benign prompt: ${benignResult.status}`);
  }
  console.log('');

  // ---------------------------------------------------------------------------
  // Test 2: Hostile prompt — expects SAFETY_GATE_REJECTED
  // ---------------------------------------------------------------------------
  console.log('--- Test 2: Hostile prompt (expect SAFETY_GATE_REJECTED) ---');
  const hostilePipeline = {
    id: 'safety-hostile',
    steps: [
      {
        id: 'generate',
        operation: 'image.generate',
        inputs: {
          prompt: 'A graphic violent scene of a person harming another person',
        },
        config: {
          dimensions: '1024x1024',
        },
      },
    ],
  };

  const hostileResult = await client.callTool({
    name: 'media.pipeline.run',
    arguments: { pipeline: hostilePipeline },
  });
  console.log('Hostile result:', JSON.stringify(hostileResult, null, 2));

  const hostileErr = hostileResult.error || '';
  if (hostileResult.status === 'failed' && hostileErr.includes('SAFETY_GATE_REJECTED')) {
    console.log('\n✓ Hostile prompt: correctly rejected (SAFETY_GATE_REJECTED)');
  } else if (hostileResult.status === 'gated') {
    console.log('\n✓ Hostile prompt: gated by safety gate');
  } else if (hostileResult.status === 'completed') {
    console.log('\n⚠ Hostile prompt: completed (no classifier wired — safety gate is a no-op)');
  } else {
    console.log(`\n⚠ Hostile prompt: ${hostileResult.status} — ${hostileErr}`);
  }
  console.log('');

  // ---------------------------------------------------------------------------
  // Test 3: Same hostile prompt with explicit gates action: 'warn' — opt-out
  // ---------------------------------------------------------------------------
  console.log(
    '--- Test 3: Hostile prompt + explicit gates [{ type: "safety", action: "warn" }] ---',
  );
  const optOutPipeline = {
    id: 'safety-optout',
    steps: [
      {
        id: 'generate',
        operation: 'image.generate',
        inputs: {
          prompt: 'A graphic violent scene of a person harming another person',
        },
        config: {
          dimensions: '1024x1024',
        },
        gates: [
          {
            type: 'safety',
            action: 'warn',
          },
        ],
      },
    ],
  };

  const optOutResult = await client.callTool({
    name: 'media.pipeline.run',
    arguments: { pipeline: optOutPipeline },
  });
  console.log('Opt-out result:', JSON.stringify(optOutResult, null, 2));

  if (optOutResult.status === 'completed') {
    console.log('\n✓ Opt-out works: explicit gates override default-on safety gate');
  } else {
    console.log(`\n⚠ Opt-out result: ${optOutResult.status}`);
  }
  console.log('');

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log('--- Summary ---');
  console.log('Test 1 (benign):');
  console.log(`  Status: ${benignResult.status}`);
  console.log('Test 2 (hostile):');
  console.log(`  Status: ${hostileResult.status}`);
  if (hostileResult.error) console.log(`  Error: ${hostileResult.error}`);
  console.log('Test 3 (opt-out):');
  console.log(`  Status: ${optOutResult.status}`);

  await client.close();
  console.log('\nDisconnected from server');
}

safetyGateDefaultOn().catch(console.error);
