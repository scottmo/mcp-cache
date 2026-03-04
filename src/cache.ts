/**
 * Cache manager for storing large responses
 */

import { mkdir, writeFile, readFile, readdir, unlink, stat } from 'fs/promises';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { CachedResponse, CachedTargetInterface, ResponseMetadata } from './types.js';

/** Stable JSON key for tool args (sorted keys) for cache lookup. */
export function stableArgsKey(args: Record<string, unknown> | undefined): string {
  if (args == null || typeof args !== 'object') return '{}';
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(args).sort()) {
    const v = args[k];
    sorted[k] = v && typeof v === 'object' && !Array.isArray(v) ? stableArgsKey(v as Record<string, unknown>) : v;
  }
  return JSON.stringify(sorted);
}

export class CacheManager {
  private cacheDir: string;
  private ttl: number; // seconds
  private cleanupInterval?: NodeJS.Timeout;

  constructor(cacheDir: string, ttl: number) {
    this.cacheDir = cacheDir;
    this.ttl = ttl;
    this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      await mkdir(this.cacheDir, { recursive: true });

      // Start automatic cleanup every 5 minutes
      this.startAutoCleanup();
    } catch (error) {
      console.error('Failed to create cache directory:', error);
    }
  }

  private startAutoCleanup(): void {
    // Run cleanup every 5 minutes
    const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes

    this.cleanupInterval = setInterval(async () => {
      const cleaned = await this.cleanup();
      if (cleaned > 0) {
        console.error(`mcp-cache: Cleaned up ${cleaned} expired response(s)`);
      }
    }, CLEANUP_INTERVAL);

    // Don't block process exit
    this.cleanupInterval.unref();
  }

  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }

  private generateId(tool?: string): string {
    const prefix = CacheManager.sanitizeForFilename(tool) || 'resp';
    return prefix + '_' + randomBytes(6).toString('hex');
  }

  private getFilePath(id: string): string {
    return join(this.cacheDir, `${id}.json`);
  }

  private getMetaFilePath(id: string): string {
    return join(this.cacheDir, `${id}.meta.json`);
  }

  private static sanitizeForFilename(s: string | undefined): string {
    if (s == null || s === '') return 'unknown';
    return s.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'unknown';
  }

  private getTargetInterfacePath(serverInfo?: CachedTargetInterface['serverInfo']): string {
    const name = CacheManager.sanitizeForFilename(serverInfo?.name);
    const version = CacheManager.sanitizeForFilename(serverInfo?.version);
    return join(this.cacheDir, `${name}_v${version}_target_interface.json`);
  }

  async saveTargetInterface(
    tools: CachedTargetInterface['tools'],
    serverInfo?: CachedTargetInterface['serverInfo']
  ): Promise<void> {
    const data: CachedTargetInterface = {
      tools,
      serverInfo,
      savedAt: new Date().toISOString(),
    };
    await writeFile(this.getTargetInterfacePath(serverInfo), JSON.stringify(data, null, 2), 'utf8');
  }

  async getTargetInterface(): Promise<CachedTargetInterface | null> {
    try {
      const files = await readdir(this.cacheDir);
      const interfaceFiles = files.filter(f => f.endsWith('_target_interface.json'));
      if (interfaceFiles.length === 0) return null;
      const byMtime = await Promise.all(
        interfaceFiles.map(async (f) => {
          const p = join(this.cacheDir, f);
          const s = await stat(p);
          return { path: p, mtime: s.mtimeMs };
        })
      );
      byMtime.sort((a, b) => b.mtime - a.mtime);
      const data = await readFile(byMtime[0].path, 'utf8');
      return JSON.parse(data) as CachedTargetInterface;
    } catch {
      return null;
    }
  }

  async save(tool: string, data: any, client: string, args?: Record<string, unknown>): Promise<string> {
    const id = this.generateId(tool);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.ttl * 1000);
    const argsKey = args !== undefined ? stableArgsKey(args) : undefined;

    const dataStr = JSON.stringify(data);
    const sizeBytes = Buffer.byteLength(dataStr, 'utf8');

    const cached: CachedResponse = {
      id,
      tool,
      data,
      sizeBytes,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      client,
      chunks: Math.ceil(dataStr.length / 10000), // rough estimate
      indexed: false
    };

    const metadata: ResponseMetadata = {
      id,
      tool,
      ...(argsKey !== undefined && { argsKey }),
      sizeBytes,
      createdAt: cached.createdAt,
      expiresAt: cached.expiresAt,
      client,
      chunks: cached.chunks,
      indexed: false
    };

    try {
      // Save data
      await writeFile(this.getFilePath(id), dataStr, 'utf8');

      // Save metadata
      await writeFile(this.getMetaFilePath(id), JSON.stringify(metadata, null, 2), 'utf8');

      return id;
    } catch (error) {
      console.error('Failed to save to cache:', error);
      throw error;
    }
  }

  async get(id: string): Promise<any | null> {
    try {
      // Check if expired
      const metadata = await this.getMetadata(id);
      if (metadata && new Date(metadata.expiresAt) < new Date()) {
        await this.delete(id);
        return null;
      }

      const data = await readFile(this.getFilePath(id), 'utf8');
      return JSON.parse(data);
    } catch (error) {
      return null;
    }
  }

  /** Find cached response by tool name and args key (when maxTokens===0). Returns response data or null. */
  async getByToolAndArgs(toolName: string, argsKey: string): Promise<any | null> {
    const items = await this.list();
    const meta = items.find(m => m.tool === toolName && m.argsKey === argsKey);
    if (!meta || new Date(meta.expiresAt) < new Date()) return null;
    return this.get(meta.id);
  }

  async getMetadata(id: string): Promise<ResponseMetadata | null> {
    try {
      const data = await readFile(this.getMetaFilePath(id), 'utf8');
      return JSON.parse(data);
    } catch (error) {
      return null;
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await unlink(this.getFilePath(id));
      await unlink(this.getMetaFilePath(id));
      return true;
    } catch (error) {
      return false;
    }
  }

  async list(): Promise<ResponseMetadata[]> {
    try {
      const files = await readdir(this.cacheDir);
      const metaFiles = files.filter(f => f.endsWith('.meta.json'));

      const metadata = await Promise.all(
        metaFiles.map(async (file) => {
          const id = file.replace('.meta.json', '');
          return this.getMetadata(id);
        })
      );

      return metadata.filter((m): m is ResponseMetadata => m !== null);
    } catch (error) {
      return [];
    }
  }

  async cleanup(): Promise<number> {
    const now = new Date();
    const items = await this.list();
    let cleaned = 0;

    for (const item of items) {
      if (new Date(item.expiresAt) < now) {
        await this.delete(item.id);
        cleaned++;
      }
    }

    return cleaned;
  }

  async refresh(id: string): Promise<boolean> {
    const metadata = await this.getMetadata(id);
    if (!metadata) return false;

    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.ttl * 1000);

    metadata.expiresAt = expiresAt.toISOString();

    try {
      await writeFile(this.getMetaFilePath(id), JSON.stringify(metadata, null, 2), 'utf8');
      return true;
    } catch (error) {
      return false;
    }
  }

  async getCacheSize(): Promise<number> {
    try {
      const files = await readdir(this.cacheDir);
      let totalSize = 0;

      for (const file of files) {
        const filePath = join(this.cacheDir, file);
        const stats = await stat(filePath);
        totalSize += stats.size;
      }

      return totalSize;
    } catch (error) {
      return 0;
    }
  }
}