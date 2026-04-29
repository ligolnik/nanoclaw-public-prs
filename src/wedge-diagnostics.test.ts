import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Mock child_process.spawnSync before importing the helper. Each test
// supplies its own scripted return values via mockImplementation.
// `vi.hoisted` is required because both the spawnSync mock and the tmp
// DATA_DIR are referenced inside `vi.mock` factories, which run before
// any top-level statements.
const { mockSpawnSync, TMP_DATA_DIR } = vi.hoisted(() => {
  const fsMod = require('fs') as typeof import('fs');
  const pathMod = require('path') as typeof import('path');
  const osMod = require('os') as typeof import('os');
  return {
    mockSpawnSync: vi.fn(),
    TMP_DATA_DIR: fsMod.mkdtempSync(
      pathMod.join(osMod.tmpdir(), 'nanoclaw-wedge-test-'),
    ),
  };
});
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawnSync: mockSpawnSync,
  };
});
vi.mock('./config.js', () => ({
  DATA_DIR: TMP_DATA_DIR,
  MAX_CONCURRENT_CONTAINERS: 2,
}));

import { captureWedgeDiagnostics } from './wedge-diagnostics.js';
import { logger } from './logger.js';

function ok(stdout: string) {
  return {
    pid: 1,
    output: ['', stdout, ''],
    stdout,
    stderr: '',
    status: 0,
    signal: null as NodeJS.Signals | null,
  };
}

function timedOut() {
  return {
    pid: 1,
    output: ['', '', ''],
    stdout: '',
    stderr: '',
    status: null as number | null,
    signal: 'SIGTERM' as NodeJS.Signals,
    error: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }),
  };
}

describe('captureWedgeDiagnostics', () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
  });

  afterEach(() => {
    // Sweep the tmp dir between tests so file-listing assertions are
    // deterministic.
    for (const f of fs.readdirSync(TMP_DATA_DIR)) {
      fs.rmSync(path.join(TMP_DATA_DIR, f), { recursive: true, force: true });
    }
  });

  it('writes a file containing every section in order with the expected separator', () => {
    // Sequence of commands the helper issues, in evaluation order
    // (buildSections runs the pid lookup, wchan, and inspect inline
    // before constructing the sections array, so those three precede
    // the rest):
    //   1. ps -eo pid,comm          -> agent-runner pid lookup
    //   2. cat /proc/<pid>/wchan    -> kernel wait channel
    //   3. docker inspect           -> state fields (with envs)
    //   4. docker ps                -> container summary
    //   5. docker stats             -> CPU / mem
    //   6. docker exec ps -ef       -> in-container process tree
    //   7. ss -tn || netstat -tn    -> open TCP
    //   8. docker logs --tail 100   -> tail
    mockSpawnSync
      .mockReturnValueOnce(ok('42 node'))
      .mockReturnValueOnce(ok('do_select'))
      .mockReturnValueOnce(
        ok(
          [
            'Status=running',
            'StartedAt=2026-04-29T04:00:00Z',
            'OOMKilled=false',
            'RestartCount=0',
            'Image=nanoclaw-agent',
            'Mounts=/host->/cont;',
            'EnvKeys=',
            'NANOCLAW_FOO=secret-value',
            'PATH=/usr/bin',
          ].join('\n'),
        ),
      )
      .mockReturnValueOnce(ok('nanoclaw-x\tabc123\t31 minutes ago\timg'))
      .mockReturnValueOnce(ok('1.5%\t100MiB\t2%\t0B\t0B'))
      .mockReturnValueOnce(
        ok(
          'UID PID PPID C STIME TTY TIME CMD\nroot 42 1 0 04:00 ? 00:00:01 node /app/runner.js',
        ),
      )
      .mockReturnValueOnce(ok('LISTEN 0 128 *:443 *:*'))
      .mockReturnValueOnce(ok('log line 1\nlog line 2'));

    const written = captureWedgeDiagnostics(
      'nanoclaw-x',
      {
        taskId: 'task-abc',
        scheduleType: 'cron',
        prompt: 'do the thing',
        sessionId: 'sess-1',
        runStartIso: '2026-04-29T04:00:00.000Z',
      },
      'task-timeout-30min',
    );

    expect(written).not.toBeNull();
    expect(fs.existsSync(written!)).toBe(true);

    const content = fs.readFileSync(written!, 'utf8');
    const expectedHeadings = [
      '=== timestamp ===',
      '=== container ===',
      '=== docker inspect (relevant fields) ===',
      '=== docker stats (no-stream) ===',
      '=== docker exec ps -ef ===',
      '=== /proc/42/wchan for the agent-runner Node process ===',
      '=== docker exec netstat -tn ===',
      '=== last 100 lines of docker logs ===',
      '=== context: task that triggered the watchdog ===',
    ];
    let cursor = 0;
    for (const h of expectedHeadings) {
      const idx = content.indexOf(h, cursor);
      expect(
        idx,
        `expected heading ${h} after position ${cursor}`,
      ).toBeGreaterThanOrEqual(cursor);
      cursor = idx + h.length;
    }
    // Separator between every adjacent pair of sections.
    expect(content.split('\n---\n').length).toBe(expectedHeadings.length);

    // Env values masked, keys preserved.
    expect(content).toContain('NANOCLAW_FOO=<redacted>');
    expect(content).not.toContain('secret-value');

    // Task context fields propagated.
    expect(content).toContain('task_id=task-abc');
    expect(content).toContain('schedule_type=cron');
    expect(content).toContain('reason=task-timeout-30min');
    expect(content).toContain('prompt=do the thing');

    // wchan body present (load-bearing diagnostic).
    expect(content).toContain('do_select');

    // Filename ISO timestamp safe (colons replaced).
    expect(path.basename(written!)).not.toContain(':');
  });

  it('writes file with placeholder when one command times out; other sections intact', () => {
    // Same evaluation order as the previous test:
    // pid, wchan, inspect, container, stats, ps-ef, netstat, logs.
    // Stats hangs (timedOut), every other section returns OK.
    mockSpawnSync
      .mockReturnValueOnce(ok('42 node'))
      .mockReturnValueOnce(ok('do_futex'))
      .mockReturnValueOnce(
        ok(
          'Status=running\nStartedAt=now\nOOMKilled=false\nRestartCount=0\nImage=i\nMounts=\nEnvKeys=',
        ),
      )
      .mockReturnValueOnce(ok('nanoclaw-x\tabc\t31m\timg'))
      .mockReturnValueOnce(timedOut())
      .mockReturnValueOnce(ok('ps tree here'))
      .mockReturnValueOnce(ok('netstat output'))
      .mockReturnValueOnce(ok('logs output'));

    const written = captureWedgeDiagnostics(
      'nanoclaw-x',
      { taskId: 'task-abc' },
      'task-timeout-30min',
    );

    expect(written).not.toBeNull();
    const content = fs.readFileSync(written!, 'utf8');

    // Hung section gets the placeholder.
    expect(content).toMatch(
      /=== docker stats \(no-stream\) ===\n\(timeout — command blocked\)/,
    );
    // Adjacent sections still present and intact.
    expect(content).toContain('ps tree here');
    expect(content).toContain('do_futex');
    expect(content).toContain('logs output');
    // Total separator count unchanged — one file, all 9 sections.
    expect(content.split('\n---\n').length).toBe(9);
  });

  it('logs a warn but does not throw when atomic write fails', () => {
    mockSpawnSync.mockReturnValue(ok('output'));

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation(() => {
      throw new Error('disk full');
    });

    let result: string | null | undefined;
    expect(() => {
      result = captureWedgeDiagnostics(
        'nanoclaw-x',
        { taskId: 'task-abc' },
        'task-timeout-30min',
      );
    }).not.toThrow();
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [ctx, msg] = warnSpy.mock.calls[0];
    expect(msg).toMatch(/Wedge diagnostic capture failed/);
    expect((ctx as { containerName: string }).containerName).toBe('nanoclaw-x');

    warnSpy.mockRestore();
    openSpy.mockRestore();
  });
});
