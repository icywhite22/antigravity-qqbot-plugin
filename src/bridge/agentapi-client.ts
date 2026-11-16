import { spawn } from 'node:child_process';
import type { AppLogger } from '../shared/types.ts';

export interface AgentApiInvocation {
  executable: string;
  prefixArgs: readonly string[];
}

export interface AgentApiRunRequest {
  executable: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface AgentApiRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type AgentApiRunner = (request: AgentApiRunRequest) => Promise<AgentApiRunResult>;

export interface AgentApiClientOptions {
  invocation?: AgentApiInvocation;
  runner?: AgentApiRunner;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  defaultModel?: string;
  defaultProfile?: string;
  logger?: AppLogger;
}

export interface NewConversationOptions {
  title?: string;
  model?: string;
  profile?: string;
  cwd?: string;
}

export interface SendMessageOptions {
  title?: string;
  cwd?: string;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const UUID_REGEX = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

/**
 * 解析当前环境用于调用 agentapi 的可执行命令与固定前缀参数。
 *
 * 优先读取 ANTIGRAVITY_AGENTAPI_EXE 指向的 language_server 可执行文件，
 * 避免 Windows 非 ASCII 用户目录下直接调用 agentapi.bat 出现路径解析失败。
 */
export function resolveAgentApiCommand(env: NodeJS.ProcessEnv = process.env): AgentApiInvocation {
  const exePath = env.ANTIGRAVITY_AGENTAPI_EXE?.trim();
  if (exePath) {
    return {
      executable: exePath,
      prefixArgs: ['agentapi'],
    };
  }

  return {
    executable: 'agentapi',
    prefixArgs: [],
  };
}

/**
 * 使用 `spawn` 直接执行二进制命令（禁止通过 shell 拼接用户消息）。
 */
export function defaultAgentApiRunner(request: AgentApiRunRequest): Promise<AgentApiRunResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(request.executable, [...request.args], {
      cwd: request.cwd,
      env: request.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;

    const timeoutMs = request.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanupTimers = (): void => {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
    };

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          child.kill('SIGKILL');
        }, 2_000);
        killTimer.unref?.();
      }, timeoutMs);
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutBytes < MAX_OUTPUT_BYTES) {
        const remaining = MAX_OUTPUT_BYTES - stdoutBytes;
        stdoutChunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk);
      }
      stdoutBytes += chunk.length;
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes < MAX_OUTPUT_BYTES) {
        const remaining = MAX_OUTPUT_BYTES - stderrBytes;
        stderrChunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk);
      }
      stderrBytes += chunk.length;
    });

    child.once('error', (err: Error) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      rejectPromise(new Error(`Failed to execute ${request.executable}: ${err.message}`, { cause: err }));
    });

    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');

      if (timedOut) {
        rejectPromise(new Error(`${request.executable} timed out after ${timeoutMs}ms`));
        return;
      }
      if (code === null && signal) {
        rejectPromise(new Error(`${request.executable} terminated by signal ${signal}`));
        return;
      }
      resolvePromise({
        exitCode: code,
        stdout,
        stderr,
      });
    });
  });
}

function tryParseJsonObject(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 尝试从带有日志前缀/后缀的多行输出中提取最后一个 JSON 对象
  }

  const lines = trimmed.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (!line || !line.startsWith('{') || !line.endsWith('}')) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 继续尝试其它行
    }
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      const parsed: unknown = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function extractJsonErrorMessage(obj: Record<string, unknown>): string | undefined {
  const errVal = obj.error;
  if (typeof errVal === 'string' && errVal.trim()) {
    return errVal.trim();
  }
  if (errVal && typeof errVal === 'object' && !Array.isArray(errVal)) {
    const nested = (errVal as Record<string, unknown>).message;
    if (typeof nested === 'string' && nested.trim()) {
      return nested.trim();
    }
    return JSON.stringify(errVal);
  }
  return undefined;
}

function findFieldBfs(root: Record<string, unknown>, keys: readonly string[]): string | undefined {
  const queue: Record<string, unknown>[] = [root];
  const visited = new Set<Record<string, unknown>>();
  const priorityContainers = ['response', 'data', 'result', 'conversation', 'conversationMetadata', 'metadata'];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);

    for (const key of keys) {
      const val = current[key];
      if (typeof val === 'string' && val.trim()) {
        return val.trim();
      }
    }

    for (const containerKey of priorityContainers) {
      const child = current[containerKey];
      if (child && typeof child === 'object' && !Array.isArray(child)) {
        queue.push(child as Record<string, unknown>);
      }
    }

    for (const [k, v] of Object.entries(current)) {
      if (priorityContainers.includes(k)) continue;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        queue.push(v as Record<string, unknown>);
      }
    }
  }

  return undefined;
}

/**
 * 从 `agentapi new-conversation` 标准输出中稳健解析 `conversationId`。
 */
export function parseConversationId(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error('agentapi new-conversation returned empty stdout');
  }

  const parsedObj = tryParseJsonObject(trimmed);
  if (parsedObj) {
    const jsonErr = extractJsonErrorMessage(parsedObj);
    if (jsonErr) {
      throw new Error(`agentapi new-conversation error: ${jsonErr}`);
    }

    const primaryId = findFieldBfs(parsedObj, [
      'conversationId',
      'conversation_id',
      'cascadeId',
      'cascade_id',
    ]);
    if (primaryId) {
      return primaryId;
    }

    const responseVal = parsedObj.response;
    if (typeof responseVal === 'string' && responseVal.trim()) {
      return responseVal.trim();
    }

    const fallbackIdContainers: Record<string, unknown>[] = [parsedObj];
    for (const key of ['response', 'data', 'result', 'conversation']) {
      const child = parsedObj[key];
      if (child && typeof child === 'object' && !Array.isArray(child)) {
        fallbackIdContainers.push(child as Record<string, unknown>);
      }
    }
    for (const container of fallbackIdContainers) {
      const idVal = container.id;
      if (typeof idVal === 'string' && idVal.trim()) {
        return idVal.trim();
      }
    }
  }

  const uuidMatch = trimmed.match(UUID_REGEX);
  if (uuidMatch?.[0]) {
    return uuidMatch[0];
  }

  const preview = trimmed.length > 240 ? `${trimmed.slice(0, 240)}...` : trimmed;
  throw new Error(`Unable to parse conversationId from agentapi output: ${preview}`);
}

function formatCommandFailure(action: string, result: AgentApiRunResult): Error {
  const fromStdout = tryParseJsonObject(result.stdout);
  const fromStderr = tryParseJsonObject(result.stderr);
  const jsonErr =
    (fromStdout ? extractJsonErrorMessage(fromStdout) : undefined) ??
    (fromStderr ? extractJsonErrorMessage(fromStderr) : undefined);

  const detail = jsonErr || result.stderr.trim() || result.stdout.trim();
  const codeLabel = result.exitCode === null ? 'unknown' : String(result.exitCode);
  return new Error(
    detail
      ? `agentapi ${action} failed (exitCode=${codeLabel}): ${detail}`
      : `agentapi ${action} failed (exitCode=${codeLabel})`,
  );
}

/**
 * 封装对本地 Antigravity `agentapi` CLI 的子进程调用。
 */
export class AgentApiClient {
  private readonly invocation: AgentApiInvocation;
  private readonly runner: AgentApiRunner;
  private readonly cwd: string | undefined;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly timeoutMs: number;
  private readonly defaultModel: string | undefined;
  private readonly defaultProfile: string | undefined;
  private readonly logger: AppLogger | undefined;

  constructor(options: AgentApiClientOptions = {}) {
    this.env = options.env;
    this.invocation = options.invocation ?? resolveAgentApiCommand(options.env ?? process.env);
    this.runner = options.runner ?? defaultAgentApiRunner;
    this.cwd = options.cwd;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.defaultModel = options.defaultModel?.trim() || undefined;
    this.defaultProfile = options.defaultProfile?.trim() || undefined;
    this.logger = options.logger;
  }

  getInvocation(): AgentApiInvocation {
    return {
      executable: this.invocation.executable,
      prefixArgs: [...this.invocation.prefixArgs],
    };
  }

  async newConversation(prompt: string, options: NewConversationOptions = {}): Promise<string> {
    if (typeof prompt !== 'string' || !prompt) {
      throw new Error('AgentApiClient.newConversation requires a non-empty prompt');
    }

    const flags: string[] = [];
    const model = options.model?.trim() || this.defaultModel;
    const title = options.title?.trim();
    const profile = options.profile?.trim() || this.defaultProfile;

    if (model) {
      flags.push(`--model=${model}`);
    }
    if (title) {
      flags.push(`--title=${title}`);
    }
    if (profile) {
      flags.push(`--profile=${profile}`);
    }

    const args = [...this.invocation.prefixArgs, 'new-conversation', ...flags, '--', prompt];
    const effectiveCwd = options.cwd ?? this.cwd;
    this.logger?.debug?.(`[bridge:agentapi] exec ${this.invocation.executable} new-conversation`);

    const result = await this.runner({
      executable: this.invocation.executable,
      args,
      ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
      ...(this.env !== undefined ? { env: this.env } : {}),
      timeoutMs: this.timeoutMs,
    });

    if (result.exitCode !== 0) {
      throw formatCommandFailure('new-conversation', result);
    }

    return parseConversationId(result.stdout);
  }

  async sendMessage(
    conversationId: string,
    content: string,
    options: SendMessageOptions = {},
  ): Promise<void> {
    const trimmedId = conversationId.trim();
    if (!trimmedId) {
      throw new Error('AgentApiClient.sendMessage requires a non-empty conversationId');
    }
    if (typeof content !== 'string' || !content) {
      throw new Error('AgentApiClient.sendMessage requires non-empty content');
    }

    const flags: string[] = [];
    const title = options.title?.trim();
    if (title) {
      flags.push(`--title=${title}`);
    }

    const args = [...this.invocation.prefixArgs, 'send-message', ...flags, '--', trimmedId, content];
    const effectiveCwd = options.cwd ?? this.cwd;
    this.logger?.debug?.(
      `[bridge:agentapi] exec ${this.invocation.executable} send-message (${trimmedId})`,
    );

    const result = await this.runner({
      executable: this.invocation.executable,
      args,
      ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
      ...(this.env !== undefined ? { env: this.env } : {}),
      timeoutMs: this.timeoutMs,
    });

    if (result.exitCode !== 0) {
      throw formatCommandFailure('send-message', result);
    }

    const parsedObj = tryParseJsonObject(result.stdout);
    if (parsedObj) {
      const jsonErr = extractJsonErrorMessage(parsedObj);
      if (jsonErr) {
        throw new Error(`agentapi send-message error: ${jsonErr}`);
      }
    }
  }
}
