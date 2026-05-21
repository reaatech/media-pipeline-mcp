import type { PipelineDefinition, PipelineEstimate } from '@reaatech/media-pipeline-mcp-core';

export type { PipelineEstimate } from '@reaatech/media-pipeline-mcp-core';

export interface PipelineEstimator {
  estimate(pipeline: PipelineDefinition): Promise<PipelineEstimate>;
}

export async function handlePipelineEstimate(
  estimator: PipelineEstimator,
  args: { pipeline: PipelineDefinition },
): Promise<{
  content: { type: 'text'; text: string }[];
  estimate: PipelineEstimate;
  success: boolean;
}> {
  const estimate = await estimator.estimate(args.pipeline);
  return {
    content: [{ type: 'text', text: JSON.stringify(estimate, null, 2) }],
    estimate,
    success: true,
  };
}
