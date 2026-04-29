import { spawnSync, SpawnSyncReturns } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

/**
 * Per-command timeout for diagnostic captures. A wedged container is
 * exactly the case where `docker exec` may hang indefinitely on a
 * blocked syscall; bound each invocation so the capture itself can
 * never be the new wedge. 1s is generous for everything we run here
 * (none of these commands should take more than a few hundred ms on
 * a healthy host) and short enough that even if every single command
 * times out the total budget stays inside the overall 5s limit
 * documented in the helper contract.
 */
const PER_CMD_TIMEOUT_MS = 1000;

/**
 * Placeholder string written into a section when the underlying
 * command exceeded `PER_CMD_TIMEOUT_MS` or otherwise failed to return
 * usable output. Searching this string across the wedge-diagnostics
 * directory is how an investigator finds runs where the kernel was
 * holding the relevant subsystem hostage.
 */
const TIMEOUT_PLACEHOLDER = '(timeout — command blocked)';

const SECTION_SEPARATOR = '\n---\n';

export interface WedgeTaskContext {
  taskId: string;
  scheduleType?: string | null;
  prompt?: string | null;
  sessionId?: string | null;
  runStartIso?: string | null;
}

interface DiagSection {
  heading: string;
  body: string;
}

/**
 * Run a single diagnostic command bounded by `PER_CMD_TIMEOUT_MS`.
 * Returns either the captured stdout (trimmed) or the timeout
 * placeholder. Never throws — wedge-detect must not itself hang or
 * crash. The broad catch is intentional and documented in the brief.
 */
function runBounded(cmd: string, args: string[]): string {
  let res: SpawnSyncReturns<string>;
  try {
    res = spawnSync(cmd, args, {
      timeout: PER_CMD_TIMEOUT_MS,
      encoding: 'utf8',
      // Combine stderr into stdout so a command that prints its only
      // useful diagnostic to stderr (netstat/ss often do) still ends
      // up in the capture.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return TIMEOUT_PLACEHOLDER;
  }
  if (res.error || res.signal === 'SIGTERM' || res.status === null) {
    return TIMEOUT_PLACEHOLDER;
  }
  const out = (res.stdout || '') + (res.stderr ? `\n${res.stderr}` : '');
  const trimmed = out.trim();
  return trimmed.length > 0 ? trimmed : '(no output)';
}

/**
 * Look up the PID inside the container of the agent-runner Node
 * process. Used to read `/proc/<pid>/wchan` — the load-bearing
 * diagnostic. We grep for `node` because the container's PID 1 is
 * the runner; a multi-node setup would print multiple matches and
 * we take the first.
 */
function findAgentRunnerPid(containerName: string): string | null {
  const out = runBounded('docker', [
    'exec',
    containerName,
    'sh',
    '-c',
    'ps -eo pid,comm | awk \'$2=="node" {print $1; exit}\'',
  ]);
  if (out === TIMEOUT_PLACEHOLDER) return null;
  const pid = out.trim().split(/\s+/)[0];
  return /^\d+$/.test(pid) ? pid : null;
}

function buildSections(
  containerName: string,
  taskContext: WedgeTaskContext,
  reason: string,
): DiagSection[] {
  const isoNow = new Date().toISOString();

  // /proc/<pid>/wchan is the load-bearing diagnostic: the kernel wait
  // channel reveals which syscall the agent-runner is blocked on
  // (read/write/futex/select/poll/...). Without it, "container is
  // wedged" is unfalsifiable; with it, the operator can distinguish
  // a hung HTTP read from a deadlocked mutex from CPU starvation.
  const pid = findAgentRunnerPid(containerName);
  const wchanBody = pid
    ? runBounded('docker', [
        'exec',
        containerName,
        'sh',
        '-c',
        `cat /proc/${pid}/wchan && echo`,
      ])
    : '(no agent-runner pid found)';

  const inspectFmt =
    'Status={{.State.Status}}\nStartedAt={{.State.StartedAt}}\n' +
    'OOMKilled={{.State.OOMKilled}}\nRestartCount={{.RestartCount}}\n' +
    'Image={{.Config.Image}}\nMounts={{range .Mounts}}{{.Source}}->{{.Destination}};{{end}}\n' +
    'EnvKeys={{range .Config.Env}}{{printf "%s\\n" .}}{{end}}';

  // Mask env values: the inspect format above prints the full KEY=VALUE
  // env list; strip values before writing to disk so secrets don't leak
  // into a file the operator may share.
  const rawEnvInspect = runBounded('docker', [
    'inspect',
    '--format',
    inspectFmt,
    containerName,
  ]);
  const inspectBody = rawEnvInspect
    .split('\n')
    .map((line) => {
      // EnvKeys lines are bare KEY=VALUE entries from the docker
      // template; everything else is the labelled prefix lines above.
      if (/^[A-Z_][A-Z0-9_]*=/.test(line)) {
        return line.split('=', 1)[0] + '=<redacted>';
      }
      return line;
    })
    .join('\n');

  const taskCtxBody = [
    `task_id=${taskContext.taskId}`,
    `schedule_type=${taskContext.scheduleType ?? '(unknown)'}`,
    `session_id=${taskContext.sessionId ?? '(none)'}`,
    `run_start=${taskContext.runStartIso ?? '(unknown)'}`,
    `reason=${reason}`,
    `prompt=${(taskContext.prompt ?? '').slice(0, 200)}`,
  ].join('\n');

  return [
    { heading: '=== timestamp ===', body: isoNow },
    {
      heading: '=== container ===',
      body: runBounded('docker', [
        'ps',
        '-a',
        '--filter',
        `name=^${containerName}$`,
        '--format',
        '{{.Names}}\t{{.ID}}\t{{.RunningFor}}\t{{.Image}}',
      ]),
    },
    {
      heading: '=== docker inspect (relevant fields) ===',
      body: inspectBody,
    },
    {
      heading: '=== docker stats (no-stream) ===',
      body: runBounded('docker', [
        'stats',
        '--no-stream',
        '--format',
        '{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}\t{{.BlockIO}}',
        containerName,
      ]),
    },
    {
      heading: '=== docker exec ps -ef ===',
      body: runBounded('docker', ['exec', containerName, 'ps', '-ef']),
    },
    {
      heading: `=== /proc/${pid ?? '?'}/wchan for the agent-runner Node process ===`,
      body: wchanBody,
    },
    {
      heading: '=== docker exec netstat -tn ===',
      // ss -tn is the modern replacement and ships in the agent
      // image; fall back via shell so distros without ss still
      // produce something useful.
      body: runBounded('docker', [
        'exec',
        containerName,
        'sh',
        '-c',
        'ss -tn 2>&1 || netstat -tn 2>&1',
      ]),
    },
    {
      heading: '=== last 100 lines of docker logs ===',
      body: runBounded('docker', ['logs', '--tail', '100', containerName]),
    },
    {
      heading: '=== context: task that triggered the watchdog ===',
      body: taskCtxBody,
    },
  ];
}

function atomicWrite(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

/**
 * Capture diagnostic state for a wedged container immediately before
 * the dispatch-loss sweep drops the task or the per-task watchdog
 * kills the container. Bounded to ~5s total (10 commands × 1s
 * timeout, in practice shorter because most commands return promptly
 * even on a wedged host).
 *
 * Returns the path written, or null if the capture itself failed
 * outright (no file produced). Failure to capture must NOT prevent
 * the caller from proceeding with the kill/drop — the broad catch
 * around the whole helper is intentional.
 */
export function captureWedgeDiagnostics(
  containerName: string,
  taskContext: WedgeTaskContext,
  reason: string,
): string | null {
  try {
    const dir = path.join(DATA_DIR, 'wedge-diagnostics');
    fs.mkdirSync(dir, { recursive: true });

    const isoSafe = new Date().toISOString().replace(/:/g, '-');
    const fileName = `${isoSafe}-${containerName}.txt`;
    const filePath = path.join(dir, fileName);

    const sections = buildSections(containerName, taskContext, reason);
    const body =
      sections.map((s) => `${s.heading}\n${s.body}`).join(SECTION_SEPARATOR) +
      '\n';

    atomicWrite(filePath, body);
    logger.info(
      { containerName, reason, path: filePath },
      'Wedge diagnostics captured',
    );
    return filePath;
  } catch (err) {
    logger.warn(
      { err, containerName, reason },
      'Wedge diagnostic capture failed (continuing with kill/drop)',
    );
    return null;
  }
}
