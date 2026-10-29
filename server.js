#!/usr/bin/env node
/**
 * MCP server for a Kerio Connect mailbox, over the web client's HTTPS JSON-RPC API.
 *
 * Environment: KERIO_HOST, KERIO_USER, KERIO_PASSWORD (see .env.example).
 */
require('dotenv').config({ quiet: true });
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { KerioClient } = require('./src/kerio-client');
const { createTools } = require('./src/tools');

const client = new KerioClient({
  host: process.env.KERIO_HOST,
  user: process.env.KERIO_USER,
  password: process.env.KERIO_PASSWORD
});
const tools = createTools(client);

const server = new Server({ name: 'kerio-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
}));

server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const tool = tools.find(t => t.name === params.name);
  if (!tool) throw new Error(`Tool not found: ${params.name}`);
  return tool.handler(params.arguments || {});
});

server.connect(new StdioServerTransport())
  .then(() => console.error('kerio-mcp connected and listening'))
  .catch(error => { console.error(`Connection error: ${error.message}`); process.exit(1); });
