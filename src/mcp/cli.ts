import { resolve } from 'node:path';
import { loadEnvWithDotFiles, loadRuntimeConfig } from '../shared/config.ts';
import { resolveCallbackEndpoint } from './callback-client.ts';
import { createMcpServer, createStderrLogger } from './server.ts';
import type { PostCallbackReplyOptions } from './types.ts';

interface ParsedCliArgs {
  help: boolean;
  debug: boolean;
  callbackHost?: string;
  callbackPort?: number;
  timeoutMs?: number;
}

function printHelp(): void {
  process.stderr.write(
    [
      'Usage: node src/mcp/cli.ts [options]',
      '',
      'Options:',
      '  --host, --callback-host <host>   Override QQBOT_CALLBACK_HOST',
      '  --port, --callback-port <port>   Override QQBOT_CALLBACK_PORT (1-65535)',
      '  --timeout-ms <ms>                HTTP callback request timeout in ms',
      '  --debug                          Enable verbose diagnostics on stderr',
      '  -h, --help                       Show this help message',
      '',
    ].join('\n'),
  );
}

function readFlagValue(argv: readonly string[], index: number, flagName: string, inlineValue?: string): {
  value: string;
  nextIndex: number;
} {
  if (inlineValue !== undefined) {
    if (!inlineValue) {
      throw new Error(`Missing value for ${flagName}`);
    }
    return { value: inlineValue, nextIndex: index };
  }
  const next = argv[index + 1];
  if (next === undefined || next.startsWith('-')) {
    throw new Error(`Missing value for ${flagName}`);
  }
  return { value: next, nextIndex: index + 1 };
}

function parsePositiveIntStrict(raw: string, label: string, max?: number): number {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid ${label}: "${raw}"`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || (max !== undefined && parsed > max)) {
    throw new Error(`Invalid ${label}: "${raw}"`);
  }
  return parsed;
}

function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const result: ParsedCliArgs = {
    help: false,
    debug: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) {
      continue;
    }

    if (token === '-h' || token === '--help') {
      result.help = true;
      continue;
    }
    if (token === '--debug') {
      result.debug = true;
      continue;
    }

    const eqIdx = token.indexOf('=');
    const flag = eqIdx >= 0 ? token.slice(0, eqIdx) : token;
    const inlineValue = eqIdx >= 0 ? token.slice(eqIdx + 1) : undefined;

    if (flag === '--host' || flag === '--callback-host') {
      const read = readFlagValue(argv, i, flag, inlineValue);
      result.callbackHost = read.value.trim();
      if (!result.callbackHost) {
        throw new Error(`Invalid ${flag}: host must not be empty`);
      }
      i = read.nextIndex;
      continue;
    }

    if (flag === '--port' || flag === '--callback-port') {
      const read = readFlagValue(argv, i, flag, inlineValue);
      result.callbackPort = parsePositiveIntStrict(read.value, flag, 65535);
      i = read.nextIndex;
      continue;
    }

    if (flag === '--timeout-ms') {
      const read = readFlagValue(argv, i, flag, inlineValue);
      result.timeoutMs = parsePositiveIntStrict(read.value, flag);
      i = read.nextIndex;
      continue;
    }

    throw new Error(`Unknown option: ${token}`);
  }

  return result;
}

async function main(): Promise<void> {
  let cliArgs: ParsedCliArgs;
  try {
    cliArgs = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(
      `[antigravity-qqbot-mcp] [ERROR] ${err instanceof Error ? err.message : String(err)}\n`,
    );
    printHelp();
    process.exitCode = 1;
    return;
  }

  if (cliArgs.help) {
    printHelp();
    return;
  }

  const projectRoot = resolve(import.meta.dirname, '..', '..');
  const env = loadEnvWithDotFiles(projectRoot, process.env);
  const runtimeConfig = loadRuntimeConfig(env);
  const debug = cliArgs.debug || runtimeConfig.debug;
  const logger = createStderrLogger(debug);

  const callbackOptions: PostCallbackReplyOptions = {
    env,
    ...(cliArgs.callbackHost !== undefined ? { callbackHost: cliArgs.callbackHost } : {}),
    ...(cliArgs.callbackPort !== undefined ? { callbackPort: cliArgs.callbackPort } : {}),
    ...(cliArgs.timeoutMs !== undefined ? { timeoutMs: cliArgs.timeoutMs } : {}),
  };

  try {
    const resolved = resolveCallbackEndpoint(callbackOptions);
    logger.debug?.(`Configured callback endpoint: ${resolved.url}`);
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  const server = createMcpServer({
    callback: callbackOptions,
    logger,
    debug,
  });

  server.start();

  await new Promise<void>((resolveDone) => {
    let shuttingDown = false;

    const shutdown = (reason: string, destroyStdin: boolean): void => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      logger.debug?.(`Shutting down MCP server (${reason})`);
      process.off('SIGINT', onSigInt);
      process.off('SIGTERM', onSigTerm);
      process.stdin.off('end', onStdinEnd);
      process.stdin.off('close', onStdinClose);

      void server.stop().finally(() => {
        if (destroyStdin && !process.stdin.destroyed) {
          process.stdin.destroy();
        }
        resolveDone();
      });
    };

    const onSigInt = (): void => shutdown('SIGINT', true);
    const onSigTerm = (): void => shutdown('SIGTERM', true);
    const onStdinEnd = (): void => shutdown('stdin end', false);
    const onStdinClose = (): void => shutdown('stdin close', false);

    process.on('SIGINT', onSigInt);
    process.on('SIGTERM', onSigTerm);
    process.stdin.once('end', onStdinEnd);
    process.stdin.once('close', onStdinClose);
  });
}

void main().catch((err) => {
  process.stderr.write(
    `[antigravity-qqbot-mcp] [ERROR] Fatal startup error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exitCode = 1;
});
