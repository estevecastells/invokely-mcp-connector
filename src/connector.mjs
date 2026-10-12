import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';

const AUTHENTICATED_ENDPOINT = new URL('https://invokely.ai/mcp');
const TRIAL_ENDPOINT = new URL('https://invokely.ai/mcp/trial');
const SAFE_ERROR = 'The Invokely MCP service could not complete the request.';

function endpointFor(apiKey) {
  return apiKey ? AUTHENTICATED_ENDPOINT : TRIAL_ENDPOINT;
}

function safeFetch(fetchImpl, endpoint) {
  return async (input, init = {}) => {
    const requestUrl = input instanceof Request ? input.url : String(input);
    let parsedUrl;
    try {
      parsedUrl = new URL(requestUrl);
    } catch {
      throw new Error('The Invokely endpoint is invalid.');
    }
    if (parsedUrl.href !== endpoint.href) {
      throw new Error('Requests are limited to the configured Invokely endpoint.');
    }

    const response = await fetchImpl(input, { ...init, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      throw new Error('The Invokely service redirected the request.');
    }
    return response;
  };
}

function getApiKey(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || /[\r\n]/.test(value)) {
    throw new Error('Invalid API key configuration.');
  }
  const normalized = value.trim();
  return normalized || undefined;
}

export function createConnector({ apiKey: apiKeyValue = process.env.INVOKELY_API_KEY, fetchImpl = fetch } = {}) {
  const apiKey = getApiKey(apiKeyValue);
  const endpoint = endpointFor(apiKey);
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const upstreamFetch = safeFetch(fetchImpl, endpoint);

  let upstreamClient;
  let connectionPromise;
  let closingPromise;
  let shutdownPromise;
  let isClosed = false;

  const server = new Server(
    { name: 'invokely-mcp-connector', version: '0.1.0' },
    { capabilities: { tools: { listChanged: false } } },
  );

  async function closeUpstream() {
    if (closingPromise) return closingPromise;
    isClosed = true;
    closingPromise = (async () => {
      const client = upstreamClient;
      upstreamClient = undefined;
      if (client) await client.close().catch(() => {});
    })();
    return closingPromise;
  }

  async function close() {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      await closeUpstream();
      if (server.transport) await server.close().catch(() => {});
    })();
    return shutdownPromise;
  }

  server.onclose = () => {
    void closeUpstream();
  };
  server.onerror = () => {};

  async function getUpstreamClient() {
    if (isClosed) throw new Error(SAFE_ERROR);
    if (connectionPromise) return connectionPromise;
    if (upstreamClient) return upstreamClient;

    const client = new Client({ name: 'invokely-mcp-connector', version: '0.1.0' });
    client.onerror = () => {};
    const transport = new StreamableHTTPClientTransport(endpoint, {
      fetch: upstreamFetch,
      requestInit: { headers },
    });
    upstreamClient = client;

    connectionPromise = (async () => {
      try {
        await client.connect(transport);
        if (isClosed) {
          await client.close().catch(() => {});
          throw new Error(SAFE_ERROR);
        }
        return client;
      } catch {
        if (upstreamClient === client) upstreamClient = undefined;
        await client.close().catch(() => {});
        throw new Error(SAFE_ERROR);
      } finally {
        connectionPromise = undefined;
      }
    })();

    return connectionPromise;
  }

  async function forward(operation) {
    try {
      const client = await getUpstreamClient();
      return await operation(client);
    } catch {
      throw new McpError(ErrorCode.InternalError, SAFE_ERROR);
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, request => forward(client =>
    client.listTools(request.params?.cursor !== undefined ? { cursor: request.params.cursor } : undefined),
  ));

  server.setRequestHandler(CallToolRequestSchema, request => forward(client =>
    client.callTool({
      name: request.params.name,
      ...(request.params.arguments === undefined ? {} : { arguments: request.params.arguments }),
    }),
  ));

  return { server, close, endpoint: new URL(endpoint.href) };
}

export const endpoints = Object.freeze({
  authenticated: AUTHENTICATED_ENDPOINT.href,
  trial: TRIAL_ENDPOINT.href,
});
