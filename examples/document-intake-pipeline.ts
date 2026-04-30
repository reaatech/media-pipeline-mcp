/**
 * Example: Document Intake Pipeline
 *
 * Demonstrates the document-intake template pipeline:
 * OCR → extract fields → validate → summarize
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function documentIntakePipeline() {
  const client = new Client(
    { name: 'example-document-intake', version: '1.0.0' },
    { capabilities: {} },
  );

  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:8080'));
  await client.connect(transport);

  console.log('Connected to media-pipeline-mcp server\n');

  // Define the document intake pipeline
  const pipelineDefinition = {
    id: 'document-intake-demo',
    steps: [
      {
        id: 'ocr',
        operation: 'document.ocr',
        inputs: {
          artifact_id: 'invoice-scan-001', // Pre-uploaded image of invoice
        },
        config: {
          output_format: 'structured_json',
        },
      },
      {
        id: 'extract_fields',
        operation: 'document.extract_fields',
        inputs: {
          artifact_id: '{{ocr.output}}',
        },
        config: {
          field_schema: {
            invoice_number: 'string',
            invoice_date: 'date',
            vendor_name: 'string',
            total_amount: 'number',
            tax_amount: 'number',
            line_items: 'array',
          },
        },
      },
      {
        id: 'summarize',
        operation: 'document.summarize',
        inputs: {
          artifact_id: '{{extract_fields.output}}',
        },
        config: {
          length: 'short',
          style: 'structured',
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
documentIntakePipeline().catch(console.error);
