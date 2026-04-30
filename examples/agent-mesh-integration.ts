/**
 * Example: Agent Mesh Integration
 *
 * Demonstrates how agent-mesh orchestrator delegates media tasks to this MCP server.
 * This shows media as a service in a multi-agent system.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Simulated agent-mesh orchestrator
class AgentMeshOrchestrator {
  private mediaClient: Client;
  private transport: StreamableHTTPClientTransport;

  constructor(mediaServerUrl: string) {
    this.mediaClient = new Client(
      { name: 'agent-mesh-orchestrator', version: '1.0.0' },
      { capabilities: {} },
    );
    this.transport = new StreamableHTTPClientTransport(new URL(mediaServerUrl));
  }

  async connect() {
    await this.mediaClient.connect(this.transport);
    console.log('Agent-mesh orchestrator connected to media-pipeline-mcp\n');
  }

  async delegateMediaTask(task: string, params: Record<string, unknown>) {
    console.log(`[Agent Mesh] Delegating task: ${task}`);
    const result = await this.mediaClient.callTool({
      name: task,
      arguments: params,
    });
    console.log(`[Agent Mesh] Task completed: ${task}\n`);
    return result;
  }

  async executeMediaPipeline(pipelineDefinition: Record<string, unknown>) {
    console.log('[Agent Mesh] Executing media pipeline');
    const result = await this.mediaClient.callTool({
      name: 'media.pipeline.run',
      arguments: { pipeline: pipelineDefinition },
    });
    console.log('[Agent Mesh] Pipeline completed\n');
    return result;
  }

  async close() {
    await this.mediaClient.close();
    console.log('Agent-mesh orchestrator disconnected');
  }
}

// Main demonstration
async function agentMeshIntegration() {
  const orchestrator = new AgentMeshOrchestrator('http://localhost:8080');
  await orchestrator.connect();

  // Task 1: Generate marketing image
  console.log('--- Task 1: Generate marketing image ---');
  const imageResult = await orchestrator.delegateMediaTask('image.generate', {
    prompt: 'Modern tech startup office with diverse team collaborating',
    dimensions: '1920x1080',
    model: 'sd3',
  });
  console.log('Generated image artifact:', imageResult.artifact_id || 'none');
  console.log('');

  // Task 2: Create social media kit pipeline
  console.log('--- Task 2: Social media kit pipeline ---');
  const pipelineResult = await orchestrator.executeMediaPipeline({
    id: 'social-media-kit',
    steps: [
      {
        id: 'generate',
        operation: 'image.generate',
        inputs: {
          prompt: 'Minimalist logo for AI startup, blue and white',
        },
        config: {
          dimensions: '1024x1024',
          model: 'sd3',
        },
      },
      {
        id: 'resize_square',
        operation: 'image.resize',
        inputs: {
          artifact_id: '{{generate.output}}',
        },
        config: {
          dimensions: '1080x1080',
        },
      },
      {
        id: 'resize_story',
        operation: 'image.resize',
        inputs: {
          artifact_id: '{{generate.output}}',
        },
        config: {
          dimensions: '1080x1920',
        },
      },
      {
        id: 'resize_banner',
        operation: 'image.resize',
        inputs: {
          artifact_id: '{{generate.output}}',
        },
        config: {
          dimensions: '1500x500',
        },
      },
    ],
  });
  console.log('Social media kit artifacts:', pipelineResult.artifacts?.length || 0);
  console.log('');

  // Task 3: Get cost summary for billing
  console.log('--- Task 3: Cost tracking ---');
  const costResult = await orchestrator.delegateMediaTask('media.costs.summary', {});
  console.log('Cost summary:', JSON.stringify(costResult, null, 2));

  await orchestrator.close();
}

// Run the example
agentMeshIntegration().catch(console.error);
