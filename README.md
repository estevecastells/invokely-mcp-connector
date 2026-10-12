# Invokely MCP connector

This repository contains a local stdio adapter for Invokely's hosted MCP service. It reads the hosted server's tool list and schemas, forwards calls, and returns the hosted results. The connector does not include Invokely's service implementation.

The adapter uses `https://invokely.ai/mcp/trial` when `INVOKELY_API_KEY` is unset. The trial service allows 25 calls per day per IP address. When a key is configured, the adapter uses `https://invokely.ai/mcp` and sends the key as an Authorization bearer token.

## Requirements

- Node.js 22 or later
- An MCP client that can launch a local stdio server

## Run from a checkout

Clone the public repository and install its dependencies:

```sh
git clone https://github.com/estevecastells/invokely-mcp-connector.git
cd invokely-mcp-connector
npm install
```

An MCP client can launch the connector with Node and the checkout's absolute path:

```json
{
  "mcpServers": {
    "invokely": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/invokely-mcp-connector/src/cli.mjs"]
    }
  }
}
```

Replace both paths with paths on your computer. This uses trial access. To use an API key, configure `INVOKELY_API_KEY` in the MCP client's environment settings. Use the client's local secret setting when available, and avoid putting a real key in a JSON configuration file. You can also run the connector directly from the checkout with `npm start`.

## Run from GitHub with npx

An MCP client can install and launch the connector from its public GitHub repository:

```json
{
  "mcpServers": {
    "invokely": {
      "command": "npx",
      "args": ["-y", "github:estevecastells/invokely-mcp-connector"]
    }
  }
}
```

This command was tested with Node.js 22 from a clean temporary directory. It uses trial access unless `INVOKELY_API_KEY` is set in the MCP client's environment. The connector is not published to npm, so the bare package command `npx -y invokely-mcp-connector` is not available.

To use an API key, set it in the environment that launches the connector:

```sh
INVOKELY_API_KEY=ivk_your_key npm start
```

The connector writes protocol messages to stdout and does not log requests or credentials.

The adapter supports trial access and API-key bearer authentication. It does not implement an OAuth flow.

The connector stores no key or token. The value is read from the process environment and sent only to the fixed Invokely endpoint.

## Service information

- [Invokely developer documentation](https://invokely.ai/docs)
- [Invokely machine-readable guide](https://invokely.ai/llms.txt)
- [Invokely pricing and usage](https://invokely.ai/pricing)
- [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)

This repository is an open-source connector for a hosted service. Its source code does not include the hosted backend.
