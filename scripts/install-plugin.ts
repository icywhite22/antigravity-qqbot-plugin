/**
 * 将仓库内的 plugin/ 安装到本机 Antigravity 全局插件目录
 * （默认 ~/.gemini/config/plugins/antigravity-qqbot）。
 *
 * - 自动把 REPLACE_WITH_ABSOLUTE_PATH_TO/antigravity-qqbot 替换为当前仓库真实路径
 * - 使用当前运行的 Node.js 绝对路径 (process.execPath) 作为 command，避免 PATH 差异
 * - 自动读取 .env / .env.local / 环境变量中的 QQBOT_WORKSPACE_DIR（或 --workspace 参数），
 *   在本机插件副本的 sidecar.json 中注入 agent_permissions.workspace_uris
 * - 不会修改 ~/.gemini/config/config.json 或仓库内的 plugin/ 模板
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnvWithDotFiles, loadRuntimeConfig } from '../src/shared/config.ts';

const PLACEHOLDER_PREFIX = 'REPLACE_WITH_ABSOLUTE_PATH_TO/antigravity-qqbot';

export interface InstallPluginCliArgs {
  help: boolean;
  workspaceDir?: string;
}

export interface InstallPluginOptions {
  repoRoot?: string;
  targetPluginDir?: string;
  workspaceDir?: string;
  nodeExe?: string;
  env?: NodeJS.ProcessEnv;
}

export interface InstallPluginResult {
  targetPluginDir: string;
  workspaceRoot: string;
  workspaceUri: string;
  nodeExe: string;
}

function toForwardSlashes(p: string): string {
  return p.replace(/\\/g, '/');
}

function resolvePluginsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const geminiDir = env.ANTIGRAVITY_GEMINI_DIR?.trim() || join(homedir(), '.gemini');
  const configRelDir = env.ANTIGRAVITY_CONFIG_REL_DIR?.trim() || 'config';
  return resolve(geminiDir, configRelDir, 'plugins');
}

export function parseInstallCliArgs(argv: readonly string[]): InstallPluginCliArgs {
  const parsed: InstallPluginCliArgs = { help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token) continue;
    if (token === '-h' || token === '--help') {
      parsed.help = true;
      continue;
    }
    if (token === '--workspace') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        throw new Error('Missing value for --workspace');
      }
      parsed.workspaceDir = next;
      i += 1;
      continue;
    }
    if (token.startsWith('--workspace=')) {
      const val = token.slice('--workspace='.length).trim();
      if (!val) {
        throw new Error('Missing value for --workspace');
      }
      parsed.workspaceDir = val;
      continue;
    }
    throw new Error(`Unknown option: ${token}`);
  }
  return parsed;
}

function replaceRepoPlaceholders(value: unknown, repoRootForward: string, nodeExe: string): unknown {
  if (typeof value === 'string') {
    return value.replaceAll(PLACEHOLDER_PREFIX, repoRootForward);
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceRepoPlaceholders(item, repoRootForward, nodeExe));
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(record)) {
      if (key === 'command' && val === 'node') {
        next[key] = nodeExe;
      } else {
        next[key] = replaceRepoPlaceholders(val, repoRootForward, nodeExe);
      }
    }
    return next;
  }
  return value;
}

function rewriteMcpConfig(filePath: string, repoRootForward: string, nodeExe: string): void {
  if (!existsSync(filePath)) {
    return;
  }
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  const updated = replaceRepoPlaceholders(parsed, repoRootForward, nodeExe);
  writeFileSync(filePath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
}

function rewriteSidecarConfig(
  filePath: string,
  repoRootForward: string,
  nodeExe: string,
  workspaceRoot: string,
  workspaceUri: string,
): void {
  if (!existsSync(filePath)) {
    return;
  }
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  const updated = replaceRepoPlaceholders(parsed, repoRootForward, nodeExe);
  if (updated !== null && typeof updated === 'object' && !Array.isArray(updated)) {
    const record = updated as Record<string, unknown>;
    const existingEnv =
      record.env && typeof record.env === 'object' && !Array.isArray(record.env)
        ? (record.env as Record<string, unknown>)
        : {};
    record.env = {
      ...existingEnv,
      QQBOT_WORKSPACE_DIR: workspaceRoot,
    };

    const existingPerms =
      record.agent_permissions &&
      typeof record.agent_permissions === 'object' &&
      !Array.isArray(record.agent_permissions)
        ? (record.agent_permissions as Record<string, unknown>)
        : {};
    record.agent_permissions = {
      ...existingPerms,
      workspace_uris: [workspaceUri],
    };
  }
  writeFileSync(filePath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
}

export function installLocalPlugin(options: InstallPluginOptions = {}): InstallPluginResult {
  const repoRoot = resolve(options.repoRoot ?? resolve(import.meta.dirname, '..'));
  const sourcePluginDir = resolve(repoRoot, 'plugin');
  if (!existsSync(sourcePluginDir)) {
    throw new Error(`未找到插件源目录: ${sourcePluginDir}`);
  }

  const baseEnv = options.env ?? process.env;
  const mergedEnv = loadEnvWithDotFiles(repoRoot, baseEnv);
  const runtimeConfig = loadRuntimeConfig(mergedEnv);
  const workspaceRoot = resolve(options.workspaceDir?.trim() || runtimeConfig.workspaceRoot);
  const workspaceUri = pathToFileURL(workspaceRoot).href;

  mkdirSync(workspaceRoot, { recursive: true });

  const targetPluginDir = resolve(
    options.targetPluginDir ?? join(resolvePluginsRoot(baseEnv), 'antigravity-qqbot'),
  );
  const repoRootForward = toForwardSlashes(repoRoot);
  const nodeExe = options.nodeExe ?? process.execPath;

  mkdirSync(targetPluginDir, { recursive: true });
  cpSync(sourcePluginDir, targetPluginDir, { recursive: true, force: true });

  rewriteMcpConfig(resolve(targetPluginDir, 'mcp_config.json'), repoRootForward, nodeExe);
  rewriteSidecarConfig(
    resolve(targetPluginDir, 'sidecars', 'qqbot-gateway', 'sidecar.json'),
    repoRootForward,
    nodeExe,
    workspaceRoot,
    workspaceUri,
  );

  return {
    targetPluginDir,
    workspaceRoot,
    workspaceUri,
    nodeExe,
  };
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry).toLowerCase() === resolve(import.meta.filename).toLowerCase();
}

if (isDirectRun()) {
  const cli = parseInstallCliArgs(process.argv.slice(2));
  if (cli.help) {
    console.log('用法: npm run install:plugin [-- --workspace <dir>]');
    console.log('');
    console.log('选项:');
    console.log('  --workspace <dir>   指定机器人隔离工作区根目录（默认读取 .env 中的 QQBOT_WORKSPACE_DIR）');
    console.log('  -h, --help          显示帮助信息');
  } else {
    const result = installLocalPlugin({ workspaceDir: cli.workspaceDir });
    console.log(`[install-plugin] ✔ 插件已部署到: ${result.targetPluginDir}`);
    console.log(`[install-plugin]   Node 可执行文件: ${result.nodeExe}`);
    console.log(`[install-plugin]   隔离工作区根目录: ${result.workspaceRoot}`);
    console.log(`[install-plugin]   Sidecar workspace_uris: ${result.workspaceUri}`);
    console.log('[install-plugin]   如插件已开启，请在 Antigravity 插件页重新开关一次以使最新 Sidecar 配置生效。');
  }
}
