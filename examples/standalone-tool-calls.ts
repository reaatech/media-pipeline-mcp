/**
 * Example: Standalone Tool Calls
 *
 * Demonstrates calling individual media tools without pipeline orchestration.
 * This shows the "media toolkit" use case - just call the tools you need.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function standaloneToolCalls() {
  const client = new Client({ name: 'example-standalone', version: '1.0.0' }, { capabilities: {} });

  // Connect to the MCP server
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:8080'));
  await client.connect(transport);

  console.log('Connected to media-pipeline-mcp server\n');

  // List available tools
  const tools = await client.listTools();
  console.log('Available tools:', tools.tools.map((t) => t.name).join(', '));
  console.log('');

  // Example 1: Generate an image
  console.log('--- Example 1: Generate an image ---');
  const generateResult = await client.callTool({
    name: 'image.generate',
    arguments: {
      prompt: 'A serene mountain landscape at sunset, photorealistic, 4K',
      negative_prompt: 'blurry, low quality, watermark',
      dimensions: '1024x1024',
      model: 'sd3',
    },
  });
  console.log('Generated image:', JSON.stringify(generateResult, null, 2));
  console.log('');

  // Example 2: List artifacts
  console.log('--- Example 2: List artifacts ---');
  const listResult = await client.callTool({
    name: 'media.artifact.list',
    arguments: {
      limit: 10,
    },
  });
  console.log('Artifacts:', JSON.stringify(listResult, null, 2));
  console.log('');

  // Example 3: List providers and health
  console.log('--- Example 3: Provider health ---');
  const providersResult = await client.callTool({
    name: 'media.providers.list',
    arguments: {},
  });
  console.log('Providers:', JSON.stringify(providersResult, null, 2));
  console.log('');

  // Example 4: Get cost summary
  console.log('--- Example 4: Cost summary ---');
  const costResult = await client.callTool({
    name: 'media.costs.summary',
    arguments: {},
  });
  console.log('Cost summary:', JSON.stringify(costResult, null, 2));
  console.log('');

  await client.close();
  console.log('Disconnected from server');
}

// Run the example
standaloneToolCalls().catch(console.error);
