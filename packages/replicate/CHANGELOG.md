# @reaatech/media-pipeline-mcp-replicate

## 0.4.0

### Minor Changes

- [`397859a`](https://github.com/reaatech/media-pipeline-mcp/commit/397859a9a150e565fec21a40dee77a91c539f53d) Thanks [@reaatech](https://github.com/reaatech)! - - **@reaatech/media-pipeline-mcp-deepgram** (minor): Upgraded underlying @deepgram/sdk from 3.x to 5.x — a major runtime-dependency change that required refactoring the provider to the new DeepgramClient/listen.v1.media API. Consumers should be aware of the new SDK floor.
  - **@reaatech/media-pipeline-mcp-google** (minor): Major version bumps of two runtime dependencies: @google-cloud/aiplatform (3.x→6.x) and @google-cloud/documentai (4.x→9.x). The new floor constraints materially affect downstream consumers' peer-dependency compatibility.
  - **@reaatech/media-pipeline-mcp-replicate** (minor): Upgraded the replicate SDK from 0.29.x to 1.4.0 — a major runtime-dependency bump that changes the package's minimum peer constraint and may affect downstream consumers.
