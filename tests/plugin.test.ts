import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const PLUGIN_DIR = resolve(import.meta.dirname, '..', 'plugin');

const ALLOWED_PLUGIN_MANIFEST_KEYS = new Set([
  'name',
  'displayName',
  'description',
  'version',
  'author',
  'homepage',
  'repository',
  'logo',
  'suggestedPrompts',
  'disabled',
]);

test('plugin/plugin.json uses only allowed top-level fields and keeps disabled: true', () => {
  const raw = readFileSync(join(PLUGIN_DIR, 'plugin.json'), 'utf8');
  const manifest = JSON.parse(raw) as Record<string, unknown>;

  for (const key of Object.keys(manifest)) {
    assert.ok(
      ALLOWED_PLUGIN_MANIFEST_KEYS.has(key),
      `Unexpected top-level field in plugin/plugin.json: ${key}`,
    );
  }

  assert.equal(manifest.name, 'antigravity-qqbot');
  assert.equal(manifest.disabled, true);
  assert.equal(typeof manifest.displayName, 'string');
  assert.ok((manifest.displayName as string).trim().length > 0);
  assert.equal(typeof manifest.description, 'string');
  assert.ok((manifest.description as string).trim().length > 0);
  assert.match(String(manifest.version), /^\d+\.\d+\.\d+/);
  assert.ok(Array.isArray(manifest.suggestedPrompts) && manifest.suggestedPrompts.length > 0);
});

test('plugin/mcp_config.json registers antigravity-qqbot stdio server with default callback env', () => {
  const raw = readFileSync(join(PLUGIN_DIR, 'mcp_config.json'), 'utf8');
  const config = JSON.parse(raw) as {
    mcpServers?: Record<string, { command?: unknown; args?: unknown; env?: Record<string, unknown> }>;
  };

  const server = config.mcpServers?.['antigravity-qqbot'];
  assert.ok(server, 'mcpServers.antigravity-qqbot must exist');
  assert.equal(server.command, 'node');
  assert.ok(Array.isArray(server.args) && server.args.length === 1);
  assert.match(String(server.args[0]), /src\/mcp\/cli\.ts$/);
  assert.equal(server.env?.QQBOT_CALLBACK_HOST, '127.0.0.1');
  assert.equal(server.env?.QQBOT_CALLBACK_PORT, '39871');
});

test('plugin/sidecars/qqbot-gateway/sidecar.json keeps snake_case fields pointing to gateway-entry.ts', () => {
  const raw = readFileSync(join(PLUGIN_DIR, 'sidecars', 'qqbot-gateway', 'sidecar.json'), 'utf8');
  const sidecar = JSON.parse(raw) as Record<string, unknown>;

  assert.equal(typeof sidecar.display_name, 'string');
  assert.ok((sidecar.display_name as string).trim().length > 0);
  assert.equal(typeof sidecar.description, 'string');
  assert.ok((sidecar.description as string).trim().length > 0);
  assert.equal(sidecar.command, 'node');
  assert.ok(Array.isArray(sidecar.args) && sidecar.args.length === 1);
  assert.match(String(sidecar.args[0]), /src\/gateway-entry\.ts$/);
  assert.ok(sidecar.restart_policy === 'on-failure' || sidecar.restart_policy === 'always');

  // Ensure no camelCase drift on top-level keys
  assert.equal('displayName' in sidecar, false);
  assert.equal('restartPolicy' in sidecar, false);
});

test('plugin/rules/AGENTS.md is plain markdown without frontmatter and documents qqbot_reply guardrails', () => {
  const content = readFileSync(join(PLUGIN_DIR, 'rules', 'AGENTS.md'), 'utf8');
  assert.equal(content.trimStart().startsWith('---'), false, 'rules/AGENTS.md must not have frontmatter');
  assert.match(content, /\[QQ c2c message\]/);
  assert.match(content, /\[QQ group message\]/);
  assert.match(content, /replyToken/);
  assert.match(content, /workspace:/);
  assert.match(content, /qqbot_reply/);
  assert.match(content, /QQBOT_SECRET/);
});

test('plugin/skills/qqbot-reply/SKILL.md has valid YAML frontmatter and workflow guidance', () => {
  const content = readFileSync(join(PLUGIN_DIR, 'skills', 'qqbot-reply', 'SKILL.md'), 'utf8');
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content);
  assert.ok(fmMatch?.[1], 'SKILL.md must begin with YAML frontmatter');

  const frontmatter = fmMatch[1];
  assert.match(frontmatter, /^name:\s*qqbot-reply\s*$/m);
  assert.match(frontmatter, /^description:\s*\S+/m);

  assert.match(content, /\[QQ c2c message\]/);
  assert.match(content, /\[QQ group message\]/);
  assert.match(content, /replyToken/);
  assert.match(content, /workspace:/);
  assert.match(content, /qqbot_reply/);
  assert.match(content, /QQBOT_SECRET/);
});
