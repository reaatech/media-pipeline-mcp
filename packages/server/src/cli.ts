#!/usr/bin/env node

import { loadConfig } from './config.js';
import { MCPServer } from './mcp-server.js';

async function main() {
  const config = loadConfig();
  const server = new MCPServer(config);

  // Handle shutdown signals
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    await server.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await server.start();
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
