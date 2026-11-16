import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { formatBridgePrompt, resolveAgentApiCommand } from '../src/bridge/index.ts';
import { getPlannedMcpTools } from '../src/mcp/index.ts';
import { describeQqGatewayPlan } from '../src/qq/index.ts';
import { loadRuntimeConfig } from '../src/shared/config.ts';

test('loadRuntimeConfig uses safe defaults and parses valid port', () => {
  const cfg = loadRuntimeConfig({
    QQBOT_APPID: ' 102030 ',
    QQBOT_SECRET: ' secret-val ',
    QQBOT_CALLBACK_PORT: '40123',
  });

  assert.equal(cfg.appId, '102030');
  assert.equal(cfg.appSecret, 'secret-val');
  assert.equal(cfg.callbackHost, '127.0.0.1');
  assert.equal(cfg.callbackPort, 40123);
  assert.ok(cfg.dataDir.endsWith('.antigravity-qqbot'));
  assert.ok(cfg.workspaceRoot.endsWith('workspace'));

  const customWs = loadRuntimeConfig({ QQBOT_WORKSPACE_DIR: ' /tmp/qq-workspaces ' });
  assert.ok(customWs.workspaceRoot.endsWith('qq-workspaces'));
});

test('loadRuntimeConfig falls back when callback port is invalid and accepts port 0', () => {
  const cfg = loadRuntimeConfig({ QQBOT_CALLBACK_PORT: '99999' });
  assert.equal(cfg.callbackPort, 39871);

  const ephemeral = loadRuntimeConfig({ QQBOT_CALLBACK_PORT: '0' });
  assert.equal(ephemeral.callbackPort, 0);
});

test('resolveAgentApiCommand prefers ANTIGRAVITY_AGENTAPI_EXE when present', () => {
  const withEnv = resolveAgentApiCommand({
    ANTIGRAVITY_AGENTAPI_EXE: 'C:\\Program Files\\antigravity\\language_server.exe',
  });
  assert.equal(withEnv.executable, 'C:\\Program Files\\antigravity\\language_server.exe');
  assert.deepEqual(withEnv.prefixArgs, ['agentapi']);

  const withoutEnv = resolveAgentApiCommand({});
  assert.equal(withoutEnv.executable, 'agentapi');
  assert.deepEqual(withoutEnv.prefixArgs, []);
});

test('formatBridgePrompt includes routing metadata and message body', () => {
  const prompt = formatBridgePrompt(
    {
      messageId: 'msg-1',
      scope: 'c2c',
      peerId: 'openid-1',
      senderId: 'openid-1',
      senderName: 'Alice',
      text: '你好',
      receivedAt: 1700000000000,
      replyTarget: { scope: 'c2c', targetId: 'openid-1', msgId: 'msg-1' },
    },
    'tok-123',
  );

  assert.match(prompt, /\[QQ c2c message\]/);
  assert.match(prompt, /replyToken: tok-123/);
  assert.match(prompt, /Alice \(openid-1\)/);
  assert.ok(prompt.endsWith('\n你好'));
});

test('module descriptors and plugin manifest are structurally valid', () => {
  const qqPlan = describeQqGatewayPlan();
  assert.ok(qqPlan.packages.includes('@tencent-connect/qqbot-connector'));
  assert.ok(qqPlan.packages.includes('@tencent-connect/qqbot-nodejs'));

  const tools = getPlannedMcpTools();
  assert.equal(tools[0]?.name, 'qqbot_reply');

  const manifestPath = join(import.meta.dirname, '..', 'plugin', 'plugin.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  assert.equal(manifest.name, 'antigravity-qqbot');
  assert.equal(manifest.disabled, true);
});
