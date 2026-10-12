import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { installShutdownHandlers, isDirectExecution } from '../src/cli.mjs';
import { createConnector, endpoints } from '../src/connector.mjs';

const tool = {
  name: 'get_value',
  description: 'Get a sourced statistic.',
  inputSchema: {
    type: 'object',
    properties: { indicator: { type: 'string' } },
    required: ['indicator'],
  },
  annotations: { readOnlyHint: true },
};

function upstreamFetch({ pages = {}, callResult, redirect, failureStatus, failureText, beforeInitialize } = {}) {
  const requests = [];
  const fetchImpl = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, method: init.method, headers: new Headers(init.headers), body, redirect: init.redirect, signal: init.signal });
    if (redirect) return new Response(null, { status: 302, headers: { location: redirect } });
    if (body?.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (body?.method === 'initialize') {
      await beforeInitialize?.();
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          protocolVersion: '2025-11-25',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'invokely', version: '1.0.0' },
        },
      });
    }
    if (body?.method === 'tools/list') {
      if (failureStatus) return new Response(failureText, { status: failureStatus });
      const result = pages[body.params?.cursor ?? 'first'] ?? { tools: [] };
      return Response.json({ jsonrpc: '2.0', id: body.id, result });
    }
    if (body?.method === 'tools/call') {
      return Response.json({ jsonrpc: '2.0', id: body.id, result: callResult });
    }
    if (body?.method === 'ping') return Response.json({ jsonrpc: '2.0', id: body.id, result: {} });
    return new Response(JSON.stringify({ error: 'unexpected request' }), { status: 500 });
  };
  return { fetchImpl, requests };
}

async function connectedLocalClient(connector) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'connector-test', version: '1.0.0' });
  await connector.server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

test('forwards the hosted tool schema and tool result', async () => {
  const expectedResult = {
    content: [{ type: 'text', text: '{"value":42,"source":{"citation":"Official source"}}' }],
    structuredContent: { value: 42, source: { citation: 'Official source' } },
  };
  const mock = upstreamFetch({ pages: { first: { tools: [tool] } }, callResult: expectedResult });
  const connector = createConnector({ apiKey: 'ivk_test_secret', fetchImpl: mock.fetchImpl });
  const client = await connectedLocalClient(connector);

  const listed = await client.listTools();
  assert.deepEqual(listed.tools[0], tool);
  const result = await client.callTool({ name: 'get_value', arguments: { indicator: 'population' } });
  assert.deepEqual(result, expectedResult);
  assert.deepEqual(mock.requests.find(request => request.body?.method === 'tools/call').body.params.arguments, { indicator: 'population' });
  assert.ok(mock.requests.every(request => request.url === endpoints.authenticated));
  assert.ok(mock.requests.every(request => request.headers.get('authorization') === 'Bearer ivk_test_secret'));
  assert.ok(mock.requests.every(request => request.redirect === 'manual'));

  await client.close();
  await connector.close();
});

test('forwards list pagination cursors and the remote nextCursor', async () => {
  const mock = upstreamFetch({ pages: {
    first: { tools: [tool], nextCursor: '' },
    '': { tools: [{ ...tool, name: 'get_series' }] },
  } });
  const connector = createConnector({ apiKey: '', fetchImpl: mock.fetchImpl });
  const client = await connectedLocalClient(connector);

  const pageOne = await client.listTools();
  const pageTwo = await client.listTools({ cursor: pageOne.nextCursor });
  const listRequests = mock.requests.filter(request => request.body?.method === 'tools/list');
  assert.equal(pageOne.nextCursor, '');
  assert.equal(pageTwo.tools[0].name, 'get_series');
  assert.deepEqual(listRequests.map(request => request.body.params?.cursor), [undefined, '']);
  assert.ok(mock.requests.every(request => request.url === endpoints.trial));
  assert.ok(mock.requests.every(request => request.headers.get('authorization') === null));

  await client.close();
  await connector.close();
});

test('concurrent operations await one delayed upstream initialization', async () => {
  let markInitializeStarted;
  let releaseInitialize;
  const initializeStarted = new Promise(resolve => { markInitializeStarted = resolve; });
  const initializeGate = new Promise(resolve => { releaseInitialize = resolve; });
  const expectedResult = { content: [{ type: 'text', text: '42' }] };
  const mock = upstreamFetch({
    pages: { first: { tools: [tool] } },
    callResult: expectedResult,
    beforeInitialize: async () => {
      markInitializeStarted();
      await initializeGate;
    },
  });
  const connector = createConnector({ fetchImpl: mock.fetchImpl });
  const client = await connectedLocalClient(connector);

  const listedPromise = client.listTools();
  await initializeStarted;
  const calledPromise = client.callTool({ name: 'get_value', arguments: { indicator: 'population' } });
  releaseInitialize();

  const [listed, called] = await Promise.all([listedPromise, calledPromise]);
  assert.deepEqual(listed.tools, [tool]);
  assert.deepEqual(called, expectedResult);
  assert.equal(mock.requests.filter(request => request.body?.method === 'initialize').length, 1);
  assert.equal(mock.requests.filter(request => request.body?.method === 'tools/list').length, 1);
  assert.equal(mock.requests.filter(request => request.body?.method === 'tools/call').length, 1);

  await client.close();
  await connector.close();
});

test('returns a generic protocol error when the upstream redirects', async () => {
  const mock = upstreamFetch({ redirect: 'https://attacker.example/collect' });
  const connector = createConnector({ apiKey: 'ivk_secret_that_must_not_leak', fetchImpl: mock.fetchImpl });
  const client = await connectedLocalClient(connector);

  await assert.rejects(client.listTools(), error => {
    assert.match(error.message, /could not complete the request/i);
    assert.doesNotMatch(error.message, /ivk_secret|attacker\.example/);
    return true;
  });
  assert.ok(mock.requests.every(request => request.url === endpoints.authenticated));
  await client.close();
  await connector.close();
});

test('sanitizes an upstream authentication error before returning it to the MCP client', async () => {
  const mock = upstreamFetch({ failureStatus: 401, failureText: 'Rejected token ivk_secret_that_must_not_leak' });
  const connector = createConnector({ apiKey: 'ivk_secret_that_must_not_leak', fetchImpl: mock.fetchImpl });
  const client = await connectedLocalClient(connector);

  await assert.rejects(client.listTools(), error => {
    assert.match(error.message, /could not complete the request/i);
    assert.doesNotMatch(error.message, /ivk_secret/);
    assert.doesNotMatch(error.message, /Rejected token/);
    return true;
  });
  await client.close();
  await connector.close();
});

test('rejects an API key with line breaks before any network request', async () => {
  let calls = 0;
  assert.throws(() => createConnector({ apiKey: 'key\r\nAuthorization: Bearer stolen', fetchImpl: async () => { calls += 1; } }), /Invalid API key configuration/);
  assert.equal(calls, 0);
});

test('uses only fixed Invokely hosts and aborts the upstream connection on shutdown', async () => {
  const mock = upstreamFetch({ pages: { first: { tools: [tool] } } });
  const previousOverride = process.env.INVOKELY_MCP_URL;
  process.env.INVOKELY_MCP_URL = 'https://attacker.example/mcp';
  const connector = createConnector({ fetchImpl: mock.fetchImpl });
  try {
    const client = await connectedLocalClient(connector);
    await client.listTools();
    await connector.close();

    assert.ok(mock.requests.every(request => request.url === endpoints.trial));
    assert.equal(endpoints.authenticated, 'https://invokely.ai/mcp');
    assert.equal(endpoints.trial, 'https://invokely.ai/mcp/trial');
    assert.ok(mock.requests.every(request => request.signal?.aborted === true));
  } finally {
    if (previousOverride === undefined) delete process.env.INVOKELY_MCP_URL;
    else process.env.INVOKELY_MCP_URL = previousOverride;
  }
});

test('SIGTERM closes local MCP and aborts a hung upstream initialization without stdout output', async () => {
  let resolveStarted;
  let upstreamSignal;
  const requestStarted = new Promise(resolve => { resolveStarted = resolve; });
  const hangingFetch = (_input, init) => new Promise((_resolve, reject) => {
    upstreamSignal = init.signal;
    const abort = () => reject(init.signal.reason ?? new Error('aborted'));
    if (init.signal.aborted) abort();
    else init.signal.addEventListener('abort', abort, { once: true });
    resolveStarted();
  });

  const connector = createConnector({ apiKey: 'ivk_test_secret', fetchImpl: hangingFetch });
  const client = await connectedLocalClient(connector);
  const pendingList = client.listTools().catch(error => error);
  await requestStarted;

  const processLike = new EventEmitter();
  processLike.exitCode = 0;
  let stdout = '';
  processLike.stdout = { write: chunk => { stdout += String(chunk); return true; } };
  const finishShutdown = installShutdownHandlers(connector, processLike);
  processLike.emit('SIGTERM');

  let timeout;
  const timedOut = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error('Shutdown waited for the hung initialization.')), 500);
  });
  try {
    await Promise.race([finishShutdown('SIGTERM'), timedOut]);
  } finally {
    clearTimeout(timeout);
  }

  assert.equal(upstreamSignal.aborted, true);
  assert.equal(processLike.exitCode, 143);
  assert.equal(stdout, '');
  assert.equal(processLike.listenerCount('SIGINT'), 0);
  assert.equal(processLike.listenerCount('SIGTERM'), 0);
  await pendingList;
  await client.close();
});

test('SIGINT shuts down once and uses the conventional interrupt exit code', async () => {
  const processLike = new EventEmitter();
  processLike.exitCode = 0;
  let closeCalls = 0;
  let stdout = '';
  processLike.stdout = { write: chunk => { stdout += String(chunk); return true; } };
  const finishShutdown = installShutdownHandlers({ close: async () => { closeCalls += 1; } }, processLike);

  processLike.emit('SIGINT');
  await finishShutdown('SIGINT');

  assert.equal(closeCalls, 1);
  assert.equal(processLike.exitCode, 130);
  assert.equal(stdout, '');
  assert.equal(processLike.listenerCount('SIGINT'), 0);
  assert.equal(processLike.listenerCount('SIGTERM'), 0);
});

test('detects direct execution through npm bin symlinks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'invokely-cli-symlink-'));
  const linkPath = join(directory, 'invokely-mcp-connector');
  const cliPath = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  try {
    await symlink(cliPath, linkPath);
    assert.equal(isDirectExecution(linkPath), true);
    assert.equal(isDirectExecution(join(directory, 'missing-cli')), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
