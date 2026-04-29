/**
 * Tests for readEnvFileAll (issue #18 — scheduled-task env inheritance).
 *
 * readEnvFileAll reads ALL vars from .env except those in the exclude set,
 * so scheduled-task containers get API keys without needing an explicit
 * per-key allowlist and without exposing bot tokens or SDK credentials.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { readEnvFileAll } from './env.js';

// We test readEnvFileAll with a real temp .env file so the parsing logic is
// exercised end-to-end. No fs mocking needed — the function uses
// `path.join(process.cwd(), '.env')` which we redirect via process.chdir
// to a temp dir.

describe('readEnvFileAll (issue #18)', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-env-test-'));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns all key-value pairs when no exclude set is provided', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      [
        'GOOGLE_MAPS_API_KEY=AIzaXXX',
        'TOMTOM_API_KEY=tomtom123',
        'TELEGRAM_BOT_TOKEN=tg:secret',
        '# a comment',
        '',
        'EMPTY_VAR=',
      ].join('\n'),
    );

    const result = readEnvFileAll();

    expect(result['GOOGLE_MAPS_API_KEY']).toBe('AIzaXXX');
    expect(result['TOMTOM_API_KEY']).toBe('tomtom123');
    expect(result['TELEGRAM_BOT_TOKEN']).toBe('tg:secret');
    // Empty values are omitted (consistent with readEnvFile behaviour).
    expect(result).not.toHaveProperty('EMPTY_VAR');
  });

  it('excludes vars in the provided exclude set', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      [
        'GOOGLE_MAPS_API_KEY=AIzaXXX',
        'TELEGRAM_BOT_TOKEN=tg:secret',
        'ANTHROPIC_API_KEY=sk-ant-xxx',
      ].join('\n'),
    );

    const exclude = new Set(['TELEGRAM_BOT_TOKEN', 'ANTHROPIC_API_KEY']);
    const result = readEnvFileAll(exclude);

    expect(result['GOOGLE_MAPS_API_KEY']).toBe('AIzaXXX');
    expect(result).not.toHaveProperty('TELEGRAM_BOT_TOKEN');
    expect(result).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('returns empty object when .env does not exist', () => {
    // No .env file created in tmpDir.
    const result = readEnvFileAll();
    expect(result).toEqual({});
  });

  it('strips surrounding quotes from values', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      [
        'KEY_DOUBLE="double-quoted"',
        "KEY_SINGLE='single-quoted'",
        'KEY_BARE=bare-value',
      ].join('\n'),
    );

    const result = readEnvFileAll();

    expect(result['KEY_DOUBLE']).toBe('double-quoted');
    expect(result['KEY_SINGLE']).toBe('single-quoted');
    expect(result['KEY_BARE']).toBe('bare-value');
  });

  it('skips comment lines and blank lines', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      [
        '# This is a comment',
        '',
        '  # Indented comment',
        'REAL_KEY=real-value',
        '  ',
      ].join('\n'),
    );

    const result = readEnvFileAll();

    expect(Object.keys(result)).toEqual(['REAL_KEY']);
    expect(result['REAL_KEY']).toBe('real-value');
  });

  it('when used with BLOCKED_TASK_ENV_VARS-like exclude set, passes through third-party API keys', () => {
    // Simulates the exact use case from issue #18: GOOGLE_MAPS_API_KEY and
    // TOMTOM_API_KEY must pass through to scheduled-task containers even when
    // bot tokens are excluded. The real BLOCKED_TASK_ENV_VARS is defined in
    // container-runner.ts; here we replicate its intent minimally so this
    // test doesn't have a cross-module dep.
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      [
        'GOOGLE_MAPS_API_KEY=AIzaXXX',
        'TOMTOM_API_KEY=tomtom123',
        'TELEGRAM_BOT_TOKEN=tg:secret',
        'ANTHROPIC_API_KEY=sk-ant-xxx',
        'ONECLI_AGENT_TOKEN=onecli-secret',
      ].join('\n'),
    );

    // Minimal block-list mirroring what container-runner.ts defines
    const minimalBlockList = new Set([
      'TELEGRAM_BOT_TOKEN',
      'ANTHROPIC_API_KEY',
      'ONECLI_AGENT_TOKEN',
    ]);

    const result = readEnvFileAll(minimalBlockList);

    // These MUST come through — the whole point of the fix
    expect(result['GOOGLE_MAPS_API_KEY']).toBe('AIzaXXX');
    expect(result['TOMTOM_API_KEY']).toBe('tomtom123');

    // These must be blocked
    expect(result).not.toHaveProperty('TELEGRAM_BOT_TOKEN');
    expect(result).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(result).not.toHaveProperty('ONECLI_AGENT_TOKEN');
  });
});
