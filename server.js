#!/usr/bin/env node
/**
 * MCP server for a Kerio Connect mailbox, over the web client's HTTPS JSON-RPC API.
 *
 * Environment: KERIO_HOST, KERIO_USER, KERIO_PASSWORD (see .env.example).
 */
const path = require('path');
const { loadConfigFile } = require('./src/config');
// Settings, in order of priority: environment, .env next to server.js, .env in the working directory, config.json.
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
require('dotenv').config({ quiet: true });
loadConfigFile(__dirname);
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { KerioClient } = require('./src/kerio-client');
const { createTools } = require('./src/tools');
const { createFiles } = require('./src/files');

const client = new KerioClient({
  host: process.env.KERIO_HOST,
  user: process.env.KERIO_USER,
  password: process.env.KERIO_PASSWORD
});
const tools = createTools(client, createFiles());

const server = new Server({ name: 'kerio-mcp', version: require('./package.json').version }, { capabilities: { tools: {} } });

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
