/**
 * Core MCP proxy that wraps any MCP server
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { CacheManager, stableArgsKey } from './cache.js';
import { QueryEngine } from './query.js';
import { ConfigManager } from './config.js';
import { TargetServerTransport } from './transport.js';
import { ClientInfo } from './types.js';

export type TargetStatus = 'offline' | 'connecting' | 'online' | 'error';

export class MCPProxy {
  private server: Server;
  private targetTransport: TargetServerTransport;
  private cacheManager: CacheManager;
  private queryEngine: QueryEngine;
  private configManager: ConfigManager;
  private clientInfo?: ClientInfo;
  private targetTools: Tool[] = [];
  private targetStatus: TargetStatus = 'offline';
  private targetLastError?: string;
  private targetServerInfo?: { name?: string; version?: string };
  private connectInterval?: ReturnType<typeof setInterval>;
  private effectiveAsyncTarget = false;

  constructor(private targetCommand: string, private targetArgs: string[]) {
    this.server = new Server(
      {
        name: 'mcp-cache',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.targetTransport = new TargetServerTransport(targetCommand, targetArgs);
    this.configManager = new ConfigManager();
    const config = this.configManager.getConfig();
    this.cacheManager = new CacheManager(config.cacheDir, config.ttl);
    this.queryEngine = new QueryEngine();

    this.setupHandlers();
  }

  private setupHandlers(): void {
    // Capture client info when server is connected
    this.server.onclose = async () => {
      console.error('mcp-cache: Client disconnected');
      await this.cleanup();
    };

    // Handle tool listing
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      if (!this.effectiveAsyncTarget && this.targetTools.length === 0) {
        try {
          const result = await this.targetTransport.sendRequest('tools/list');
          this.targetTools = result.tools || [];
        } catch (error) {
          console.error('Failed to get tools from target server:', error);
        }
      }
      const managementTools = this.getManagementTools();
      return {
        tools: [...this.targetTools, ...managementTools],
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;

      // Check if it's a management tool
      if (this.isManagementTool(toolName)) {
        return await this.handleManagementTool(toolName, request.params.arguments || {});
      }

      // Forward to target server and handle response
      return await this.forwardToolCall(toolName, request.params.arguments || {});
    });
  }

  private getManagementTools(): Tool[] {
    if (this.configManager.getMaxTokens() === 0) {
      return [
        {
          name: 'target_status',
          description: 'Check whether the proxied MCP server is connected and ready. Use when async mode is enabled (MCP_CACHE_ASYNC_TARGET=true).',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
      ];
    }
    return [
      {
        name: 'query_response',
        description: 'Query a cached large response using text search (case-insensitive by default), JSONPath, or regex. Results include context lines and chunk indicators. IMPORTANT: Use limit parameter to control result size - start with limit=10 for large datasets.',
        inputSchema: {
          type: 'object',
          properties: {
            response_id: {
              type: 'string',
              description: 'The ID of the cached response',
            },
            query: {
              type: 'string',
              description: 'Query string. Text search (default, case-insensitive, partial matching), JSONPath (starts with $), or regex (/pattern/flags)',
            },
            mode: {
              type: 'string',
              enum: ['text', 'jsonpath', 'regex'],
              description: 'Query mode (auto-detected if not specified)',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results to return (default: 100, recommended: 10-20 for large responses)',
            },
            contextLines: {
              type: 'number',
              description: 'Number of context lines before/after each match (default: 2)',
            },
            caseSensitive: {
              type: 'boolean',
              description: 'Enable case-sensitive search for text mode (default: false)',
            },
          },
          required: ['response_id', 'query'],
        },
      },
      {
        name: 'get_chunk',
        description: 'Get a specific chunk of a cached response',
        inputSchema: {
          type: 'object',
          properties: {
            response_id: {
              type: 'string',
              description: 'The ID of the cached response',
            },
            chunk_number: {
              type: 'number',
              description: 'Chunk number to retrieve (0-indexed)',
            },
          },
          required: ['response_id', 'chunk_number'],
        },
      },
      {
        name: 'list_responses',
        description: 'List all cached responses',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_response_info',
        description: 'Get metadata about a cached response',
        inputSchema: {
          type: 'object',
          properties: {
            response_id: {
              type: 'string',
              description: 'The ID of the cached response',
            },
          },
          required: ['response_id'],
        },
      },
      {
        name: 'refresh_response',
        description: 'Refresh the TTL of a cached response',
        inputSchema: {
          type: 'object',
          properties: {
            response_id: {
              type: 'string',
              description: 'The ID of the cached response',
            },
          },
          required: ['response_id'],
        },
      },
      {
        name: 'delete_response',
        description: 'Delete a cached response',
        inputSchema: {
          type: 'object',
          properties: {
            response_id: {
              type: 'string',
              description: 'The ID of the cached response',
            },
          },
          required: ['response_id'],
        },
      },
      {
        name: 'target_status',
        description: 'Check whether the proxied MCP server is connected and ready. Use when async mode is enabled (MCP_CACHE_ASYNC_TARGET=true).',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ];
  }

  private isManagementTool(toolName: string): boolean {
    return [
      'query_response',
      'get_chunk',
      'list_responses',
      'get_response_info',
      'refresh_response',
      'delete_response',
      'target_status',
    ].includes(toolName);
  }

  private async tryConnectTarget(): Promise<void> {
    try {
      const initResult = await this.targetTransport.sendRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'mcp-cache', version: '0.1.0' },
      });
      await this.targetTransport.sendNotification('notifications/initialized');
      this.targetStatus = 'online';
      this.targetLastError = undefined;
      this.targetServerInfo = initResult.serverInfo;
      const listResult = await this.targetTransport.sendRequest('tools/list');
      this.targetTools = listResult.tools || [];
      await this.cacheManager.saveTargetInterface(this.targetTools, this.targetServerInfo);
      if (this.connectInterval) {
        clearInterval(this.connectInterval);
        this.connectInterval = undefined;
      }
      console.error('mcp-cache: Target server connected');
    } catch (error) {
      this.targetStatus = 'error';
      this.targetLastError = (error as Error).message;
    }
  }

  private startBackgroundConnect(): void {
    const INTERVAL_MS = 5000;
    this.connectInterval = setInterval(() => this.tryConnectTarget(), INTERVAL_MS);
    this.tryConnectTarget();
  }

  private async handleManagementTool(toolName: string, args: any): Promise<any> {
    if (this.configManager.getMaxTokens() === 0 && toolName !== 'target_status') {
      return {
        content: [{ type: 'text' as const, text: `Tool ${toolName} is disabled when MCP_CACHE_MAX_TOKENS=0.` }],
        isError: true,
      };
    }
    try {
      switch (toolName) {
        case 'query_response':
          return await this.handleQueryResponse(args);
        case 'get_chunk':
          return await this.handleGetChunk(args);
        case 'list_responses':
          return await this.handleListResponses();
        case 'get_response_info':
          return await this.handleGetResponseInfo(args);
        case 'refresh_response':
          return await this.handleRefreshResponse(args);
        case 'delete_response':
          return await this.handleDeleteResponse(args);
        case 'target_status':
          return await this.handleTargetStatus();
        default:
          throw new Error(`Unknown management tool: ${toolName}`);
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${(error as Error).message}`,
          },
        ],
      };
    }
  }

  private async handleQueryResponse(args: any): Promise<any> {
    const { response_id, query, mode, limit, contextLines, caseSensitive } = args;
    const data = await this.cacheManager.get(response_id);

    if (!data) {
      throw new Error(`Response ${response_id} not found or expired`);
    }

    const results = this.queryEngine.query(data, query, { mode, limit, contextLines, caseSensitive });

    // Check if results are too large
    const resultsStr = JSON.stringify(results, null, 2);
    const MAX_RESPONSE_SIZE = 800000; // 800KB to be safe

    if (resultsStr.length > MAX_RESPONSE_SIZE) {
      // Truncate results and provide info
      const truncated = resultsStr.substring(0, MAX_RESPONSE_SIZE);

      return {
        content: [
          {
            type: 'text',
            text: `Query results are too large (${(resultsStr.length / 1024).toFixed(2)}KB). Showing first 800KB:\n\n` +
                  `${truncated}\n\n` +
                  `[... ${(resultsStr.length - MAX_RESPONSE_SIZE)} bytes truncated]\n\n` +
                  `Total results: ${results.total || 'unknown'}\n` +
                  `Tip: Use a more specific query or lower 'limit' parameter to get fewer results.`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: resultsStr,
        },
      ],
    };
  }

  private async handleGetChunk(args: any): Promise<any> {
    const { response_id, chunk_number } = args;
    const data = await this.cacheManager.get(response_id);

    if (!data) {
      throw new Error(`Response ${response_id} not found or expired`);
    }

    const config = this.configManager.getConfig();
    const result = this.queryEngine.extractChunk(data, chunk_number, config.chunkSize);

    return {
      content: [
        {
          type: 'text',
          text: `Chunk ${chunk_number + 1}/${result.totalChunks} of ${response_id}:\n\n${result.chunk}`,
        },
      ],
    };
  }

  private async handleListResponses(): Promise<any> {
    const responses = await this.cacheManager.list();

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(responses, null, 2),
        },
      ],
    };
  }

  private async handleGetResponseInfo(args: any): Promise<any> {
    const { response_id } = args;
    const metadata = await this.cacheManager.getMetadata(response_id);

    if (!metadata) {
      throw new Error(`Response ${response_id} not found`);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(metadata, null, 2),
        },
      ],
    };
  }

  private async handleRefreshResponse(args: any): Promise<any> {
    const { response_id } = args;
    const success = await this.cacheManager.refresh(response_id);

    if (!success) {
      throw new Error(`Failed to refresh ${response_id}`);
    }

    const metadata = await this.cacheManager.getMetadata(response_id);

    return {
      content: [
        {
          type: 'text',
          text: `Refreshed ${response_id}. New expiry: ${metadata?.expiresAt}`,
        },
      ],
    };
  }

  private async handleDeleteResponse(args: any): Promise<any> {
    const { response_id } = args;
    const success = await this.cacheManager.delete(response_id);

    return {
      content: [
        {
          type: 'text',
          text: success ? `Deleted ${response_id}` : `Failed to delete ${response_id}`,
        },
      ],
    };
  }

  private async handleTargetStatus(): Promise<any> {
    const payload = {
      status: this.targetStatus,
      ...(this.targetLastError && { lastError: this.targetLastError }),
      ...(this.targetServerInfo && { serverInfo: this.targetServerInfo }),
    };
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    };
  }

  private async forwardToolCall(toolName: string, args: any): Promise<any> {
    const maxTokens = this.configManager.getMaxTokens();
    const alwaysCacheAndReturn = maxTokens === 0;

    if (this.effectiveAsyncTarget && this.targetStatus !== 'online') {
      if (alwaysCacheAndReturn) {
        const argsKey = stableArgsKey(args ?? {});
        const cached = await this.cacheManager.getByToolAndArgs(toolName, argsKey);
        if (cached != null) return cached;
      }
      return {
        content: [
          {
            type: 'text',
            text: 'No cached response and proxied MCP is not available. Use target_status to check when it is ready.',
          },
        ],
        isError: true,
      };
    }

    try {
      if (alwaysCacheAndReturn) {
        const argsKey = stableArgsKey(args ?? {});
        const cached = await this.cacheManager.getByToolAndArgs(toolName, argsKey);
        if (cached != null) return cached;
      }

      // Forward to target server
      const response = await this.targetTransport.sendRequest('tools/call', {
        name: toolName,
        arguments: args,
      });

      // Check response size with multiple thresholds
      const responseSize = JSON.stringify(response).length;
      const MCP_SDK_LIMIT = 900000; // 900KB - stay under 1MB SDK limit
      const tokenLimit = maxTokens * 4; // rough token to byte conversion
      const maxSize = Math.min(MCP_SDK_LIMIT, tokenLimit);

      if (responseSize > maxSize || alwaysCacheAndReturn) {
        const responseId = await this.cacheManager.save(
          toolName,
          response,
          this.clientInfo?.name || 'unknown',
          alwaysCacheAndReturn ? (args ?? {}) : undefined
        );

        if (alwaysCacheAndReturn) {
          return response;
        }

        const metadata = await this.cacheManager.getMetadata(responseId);
        const sizeKB = (responseSize / 1024).toFixed(2);

        return {
          content: [
            {
              type: 'text',
              text: `Response too large (${sizeKB}KB, ${metadata?.chunks} chunks). Saved as ${responseId}.\n\n` +
                    `Use query_response('${responseId}', '<query>') to search.\n` +
                    `Use get_chunk('${responseId}', 0) to read first chunk.\n\n` +
                    `Expires: ${metadata?.expiresAt}`,
            },
          ],
        };
      }

      // Return response as-is if small enough
      return response;
    } catch (error) {
      const errorMsg = (error as Error).message;
      this.targetStatus = 'error';
      this.targetLastError = errorMsg;

      // If it's a size error, try to provide helpful message
      if (errorMsg.includes('maximum length') || errorMsg.includes('exceeds')) {
        return {
          content: [
            {
              type: 'text',
              text: `Response exceeded MCP protocol size limit (1MB). This is a known issue.\n\n` +
                    `The response was too large to cache. Please try:\n` +
                    `1. Using more specific queries (e.g., CSS selectors)\n` +
                    `2. Breaking the operation into smaller parts\n` +
                    `3. Using simpler tools that return less data`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: `Error calling ${toolName}: ${errorMsg}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async cleanup(): Promise<void> {
    try {
      if (this.connectInterval) {
        clearInterval(this.connectInterval);
        this.connectInterval = undefined;
      }
      await this.targetTransport.stop();
      this.cacheManager.stop();
    } catch (error) {
      console.error('Error during cleanup:', error);
    }
  }

  async start(): Promise<void> {
    await this.targetTransport.start();

    const asyncTargetRequested = this.configManager.isAsyncTarget();
    const cached = asyncTargetRequested ? await this.cacheManager.getTargetInterface() : null;
    const hasTargetInterfaceCache = (cached?.tools?.length ?? 0) > 0;

    // only use async connection if we have a cached target interface, otherwise we would not
    // have the right tools to display to the client.
    if (asyncTargetRequested && hasTargetInterfaceCache) {
      this.effectiveAsyncTarget = true;
      this.targetStatus = 'connecting';
      this.targetTools = cached!.tools as Tool[];
      if (cached!.serverInfo) this.targetServerInfo = cached!.serverInfo;
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      this.startBackgroundConnect();
      console.error('mcp-cache: Proxy started (async target). Proxied MCP will connect in background.');
    } else {
      const initResult = await this.targetTransport.sendRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'mcp-cache', version: '0.1.0' },
      });
      await this.targetTransport.sendNotification('notifications/initialized');
      this.targetStatus = 'online';
      this.targetServerInfo = initResult.serverInfo;
      const listResult = await this.targetTransport.sendRequest('tools/list');
      this.targetTools = listResult.tools || [];
      await this.cacheManager.saveTargetInterface(this.targetTools, this.targetServerInfo);

      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.error('mcp-cache: Proxy started and connected to target server');
      console.error(`Target server: ${initResult.serverInfo?.name} v${initResult.serverInfo?.version}`);
    }

    process.on('SIGINT', async () => {
      console.error('mcp-cache: Received SIGINT, shutting down...');
      await this.cleanup();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.error('mcp-cache: Received SIGTERM, shutting down...');
      await this.cleanup();
      process.exit(0);
    });

    process.on('uncaughtException', (error) => {
      if ((error as any).code === 'EPIPE') {
        console.error('mcp-cache: Client pipe closed');
        this.cleanup().then(() => process.exit(0));
      } else {
        console.error('mcp-cache: Uncaught exception:', error);
        this.cleanup().then(() => process.exit(1));
      }
    });

    this.clientInfo = { name: 'claude-ai', version: '0.1.0' };
    this.configManager = new ConfigManager(this.clientInfo);
    const config = this.configManager.getConfig();
    this.cacheManager = new CacheManager(config.cacheDir, config.ttl);
    if (!this.effectiveAsyncTarget) {
      console.error(`Client: ${this.clientInfo.name} (Token limit: ${this.configManager.getMaxTokens()})`);
    }
  }
}