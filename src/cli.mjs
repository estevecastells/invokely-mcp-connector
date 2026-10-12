#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import process from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createConnector } from './connector.mjs';

export function installShutdownHandlers(connector, processLike = process) {
  let shutdownPromise;

  const shutdown = exitCode => {
    if (shutdownPromise) return shutdownPromise;
    processLike.off('SIGINT', onInterrupt);
    processLike.off('SIGTERM', onTerminate);
    shutdownPromise = Promise.resolve()
      .then(() => connector.close())
      .then(() => { processLike.exitCode = exitCode; }, () => { processLike.exitCode = 1; });
    return shutdownPromise;
  };

  const onInterrupt = () => { void shutdown(130); };
  const onTerminate = () => { void shutdown(143); };
  processLike.once('SIGINT', onInterrupt);
  processLike.once('SIGTERM', onTerminate);

  return signal => shutdown(signal === 'SIGINT' ? 130 : 143);
}

async function main() {
  let connector;
  try {
    connector = createConnector();
    installShutdownHandlers(connector);
    await connector.server.connect(new StdioServerTransport());
  } catch {
    process.stderr.write('Invokely MCP connector could not start. Check the Node version and API key configuration.\n');
    if (connector) await connector.close();
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
