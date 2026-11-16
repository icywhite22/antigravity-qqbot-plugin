import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { installLocalPlugin, parseInstallCliArgs } from '../scripts/install-plugin.ts';

test('parseInstallCliArgs supports --workspace and --help', () => {
  assert.deepEqual(parseInstallCliArgs([]), { help: false });
  assert.deepEqual(parseInstallCliArgs(['--workspace', 'E:\\ws\\qq']), {
    help: false,
    workspaceDir: 'E:\\ws\\qq',
  });
  assert.deepEqual(parseInstallCliArgs(['--workspace=E:\\ws\\qq', '-h']), {
    help: true,
    workspaceDir: 'E:\\ws\\qq',
  });
  assert.throws(() => parseInstallCliArgs(['--unknown']), /Unknown option/);
});

test('installLocalPlugin substitutes paths and configures isolated workspace_uris without altering repo template', (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'qqbot-install-'));
  t.after(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const repoRoot = resolve(import.meta.dirname, '..');
  const workspaceDir = join(tempRoot, 'qq 机器人工作区');
  const targetPluginDir = join(tempRoot, 'installed-plugin');

  const result = installLocalPlugin({
    repoRoot,
    targetPluginDir,
    workspaceDir,
    nodeExe: 'C:\\Program Files\\nodejs\\node.exe',
  });

  assert.equal(result.targetPluginDir, targetPluginDir);
  assert.equal(result.workspaceRoot, workspaceDir);
  assert.equal(result.workspaceUri, pathToFileURL(workspaceDir).href);

  const installedMcp = JSON.parse(
    readFileSync(join(targetPluginDir, 'mcp_config.json'), 'utf8'),
  ) as { mcpServers: { 'antigravity-qqbot': { command: string; args: string[] } } };
  assert.equal(
    installedMcp.mcpServers['antigravity-qqbot'].command,
    'C:\\Program Files\\nodejs\\node.exe',
  );
  assert.equal(installedMcp.mcpServers['antigravity-qqbot'].args[0]?.includes('REPLACE_WITH_ABSOLUTE_PATH_TO'), false);

  const installedSidecar = JSON.parse(
    readFileSync(join(targetPluginDir, 'sidecars', 'qqbot-gateway', 'sidecar.json'), 'utf8'),
  ) as {
    command: string;
    args: string[];
    env: Record<string, string>;
    agent_permissions: { workspace_uris: string[] };
  };
  assert.equal(installedSidecar.command, 'C:\\Program Files\\nodejs\\node.exe');
  assert.equal(installedSidecar.args[0]?.includes('REPLACE_WITH_ABSOLUTE_PATH_TO'), false);
  assert.equal(installedSidecar.env.QQBOT_WORKSPACE_DIR, workspaceDir);
  assert.deepEqual(installedSidecar.agent_permissions.workspace_uris, [
    pathToFileURL(workspaceDir).href,
  ]);
});
