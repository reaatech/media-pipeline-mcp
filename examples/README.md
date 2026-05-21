# Examples — media-pipeline-mcp

Thirteen runnable examples demonstrating the MCP server's capabilities.

## Prerequisites

- `npx @reaatech/media-pipeline-mcp-server start` running on `localhost:8080`
- Provider API keys as needed (see per-example requirements)

## Quick Start

```bash
# Start the server
npx @reaatech/media-pipeline-mcp-server start

# Run an example in another terminal
npx tsx examples/01-dry-run-then-execute.ts
```

## Example Index

| # | Name | Features | Flags | Size | Description |
|---|------|----------|-------|------|-------------|
| 01 | dry-run-then-execute | F4, F5 | — | S | Estimate costs then execute with budget cap |
| 02 | cheapest-routing-with-fallback | F8, F2 | FEATURE_ROUTING=true | M | Smart provider routing with cache-hit rebate |
| 03 | ab-variants-with-judge | F9 | FEATURE_VARIANTS=true | M | Fan out variants, judge by LLM/rule |
| 04 | resumable-long-running | F1, F3 | — | M | Resume failed pipeline without re-paying |
| 05 | batch-1000-blog-heroes | F15, F4 | FEATURE_BATCH=true | L | CSV-driven batch with per-row budget |
| 06 | aspect-ratio-fanout | F11 | — | S | One prompt → 1:1, 9:16, 16:9 |
| 07 | voice-style-narration | F12, F13, F14 | — | L | Voice refs, style refs, loudness, captions |
| 12 | safety-gate-default-on | F16 | FEATURE_SAFETY_GATE=true | M | Default-on safety with opt-out |
| — | product-photo-pipeline | — | — | S | Generate → upscale → remove background |
| — | standalone-tool-calls | — | — | S | Use tools directly without pipelines |
| — | podcast-clip-pipeline | — | — | S | TTS → STT → diarize |
| — | document-intake-pipeline | — | — | S | OCR → extract tables → extract fields |
| — | agent-mesh-integration | — | — | S | Agent-driven pipeline with health checks |

## Feature Flags

| Flag | Purpose | Used By |
|------|---------|---------|
| FEATURE_ROUTING=true | Enable smart provider routing (F8) | #02 |
| FEATURE_VARIANTS=true | Enable A/B variant generation (F9) | #03 |
| FEATURE_BATCH=true | Enable CSV batch generation (F15) | #05 |
| FEATURE_SAFETY_GATE=true | Enable default-on moderation (F16) | #12 (default) |

## Tips

- Examples run against a mock provider if no real API keys are set — outputs are simulated
- Real provider keys produce actual generated content
- Pass `--progressToken` to see streaming progress events (F6)
