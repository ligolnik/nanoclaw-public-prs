import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Tests cross-chat send_file / send_voice from main (issue #25): chat_jid
// must be honored by main containers, dropped (blocked) for trusted/
// untrusted, and the cross-chat send must be recorded against the TARGET
// chat in messages.db so downstream agents in that chat see the artifact.

// Use a per-test data dir for the IPC watcher to scan. Mock config so
// DATA_DIR / GROUPS_DIR point at a temp tree we control. vi.mock is
// hoisted to the very top of the file (before this `import` block) so
// we cannot reference test-scope constants — fix the paths up front
// using a deterministic-per-process tmpdir name and let the mock
// factory recompute it the same way.
const TEST_ROOT = path.join(os.tmpdir(), `nanoclaw-ipc-cross-${process.pid}`);
const DATA_DIR = path.join(TEST_ROOT, 'data');
const GROUPS_DIR = path.join(TEST_ROOT, 'groups');

vi.mock('./config.js', async () => {
  const pathMod = await import('path');
  const osMod = await import('os');
  const root = pathMod.join(
    osMod.tmpdir(),
    `nanoclaw-ipc-cross-${process.pid}`,
  );
  return {
    ASSISTANT_NAME: 'TestBot',
    DATA_DIR: pathMod.join(root, 'data'),
    GROUPS_DIR: pathMod.join(root, 'groups'),
    IPC_POLL_INTERVAL: 25,
    TIMEZONE: 'America/Los_Angeles',
  };
});

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { startIpcWatcher, IpcDeps } from './ipc.js';
import {
  _getAllMessagesForChat,
  _initTestDatabase,
  setRegisteredGroup,
  storeChatMetadata,
} from './db.js';
import { RegisteredGroup } from './types.js';

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'whatsapp_main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

const OTHER_GROUP: RegisteredGroup = {
  name: 'Other',
  folder: 'other-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

// Mutated in place across tests so the watcher's `() => groups` closure
// always sees the latest registrations. Reassigning would orphan the
// watcher's reference (it was captured at startIpcWatcher time).
const groups: Record<string, RegisteredGroup> = {};

// Holders rebound per test; the watcher's deps closure dereferences via
// these so each test sees its own mock instances.
type SendMessageFn = NonNullable<IpcDeps['sendMessage']>;
type SendFileFn = NonNullable<IpcDeps['sendFile']>;
type SendVoiceFn = NonNullable<IpcDeps['sendVoice']>;
let sendFileMock: ReturnType<typeof vi.fn<SendFileFn>>;
let sendVoiceMock: ReturnType<typeof vi.fn<SendVoiceFn>>;
let sendMessageMock: ReturnType<typeof vi.fn<SendMessageFn>>;
let watcherStarted = false;

function buildDeps(): IpcDeps {
  return {
    sendMessage: (jid, text, replyToMessageId) =>
      sendMessageMock(jid, text, replyToMessageId),
    sendFile: (jid, filePath, caption, replyToMessageId) =>
      sendFileMock(jid, filePath, caption, replyToMessageId),
    sendVoice: (jid, text, voice, replyToMessageId) =>
      sendVoiceMock(jid, text, voice, replyToMessageId),
    registeredGroups: () => groups,
    registerGroup: (jid, group) => {
      groups[jid] = group;
      setRegisteredGroup(jid, group);
    },
    syncGroups: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
    onTasksChanged: () => {},
    nukeSession: () => {},
  };
}

function dropIpcMessage(sourceGroup: string, payload: Record<string, unknown>) {
  const dir = path.join(DATA_DIR, 'ipc', sourceGroup, 'messages');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(
    dir,
    `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
  );
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, file);
  return file;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitFor timed out');
}

beforeEach(() => {
  _initTestDatabase();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.rmSync(GROUPS_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(GROUPS_DIR, { recursive: true });

  // Provide source-side group folders so file-resolution succeeds when
  // the host translates /workspace/group/<file> back to the host path.
  fs.mkdirSync(path.join(GROUPS_DIR, 'whatsapp_main'), { recursive: true });
  fs.mkdirSync(path.join(GROUPS_DIR, 'other-group'), { recursive: true });

  // Pre-create per-group IPC subtree so the watcher discovers it.
  fs.mkdirSync(path.join(DATA_DIR, 'ipc', 'whatsapp_main', 'messages'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(DATA_DIR, 'ipc', 'other-group', 'messages'), {
    recursive: true,
  });

  for (const k of Object.keys(groups)) delete groups[k];
  groups['main@g.us'] = MAIN_GROUP;
  groups['other@g.us'] = OTHER_GROUP;
  setRegisteredGroup('main@g.us', MAIN_GROUP);
  setRegisteredGroup('other@g.us', OTHER_GROUP);

  // messages.chat_jid has a FK to chats(jid); seed both chats so
  // storeMessage() inside the IPC handler doesn't trip the FK.
  storeChatMetadata('main@g.us', '2024-01-01T00:00:00.000Z', 'Main');
  storeChatMetadata('other@g.us', '2024-01-01T00:00:00.000Z', 'Other');

  sendFileMock = vi.fn().mockResolvedValue(undefined);
  sendVoiceMock = vi.fn().mockResolvedValue(undefined);
  sendMessageMock = vi.fn().mockResolvedValue('1');

  if (!watcherStarted) {
    startIpcWatcher(buildDeps());
    watcherStarted = true;
  }
});

afterEach(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('send_file with chat_jid (issue #25)', () => {
  it('main can target another chat; sendFile receives target jid and caption is recorded against target', async () => {
    // Drop a real file under main's group folder so the host path translation
    // resolves to an existing file.
    const fileName = 'report.txt';
    fs.writeFileSync(path.join(GROUPS_DIR, 'whatsapp_main', fileName), 'hi');

    dropIpcMessage('whatsapp_main', {
      type: 'send_file',
      chatJid: 'other@g.us', // cross-chat target
      filePath: `/workspace/group/${fileName}`,
      caption: 'cross-chat artifact',
      groupFolder: 'whatsapp_main',
      timestamp: new Date().toISOString(),
    });

    await waitFor(() => sendFileMock.mock.calls.length > 0, 2000);
    const [jid, hostPath, caption] = sendFileMock.mock.calls[0];
    expect(jid).toBe('other@g.us');
    expect(hostPath).toBe(path.join(GROUPS_DIR, 'whatsapp_main', fileName));
    expect(caption).toBe('cross-chat artifact');

    // messages.db row must land in the TARGET chat history. The handler
    // calls storeMessage AFTER awaiting deps.sendFile, so wait until the
    // bot row shows up rather than asserting synchronously.
    await waitFor(
      () =>
        _getAllMessagesForChat('other@g.us').some(
          (r) => r.content === 'cross-chat artifact' && r.is_bot_message === 1,
        ),
      2000,
    );
  });

  it('trusted/untrusted cross-chat send_file is blocked (param effectively dropped — same gate as send_message)', async () => {
    const fileName = 'oops.txt';
    fs.writeFileSync(path.join(GROUPS_DIR, 'other-group', fileName), 'x');

    dropIpcMessage('other-group', {
      type: 'send_file',
      chatJid: 'main@g.us', // trying to target a different chat
      filePath: `/workspace/group/${fileName}`,
      caption: 'should-not-deliver',
      groupFolder: 'other-group',
      timestamp: new Date().toISOString(),
    });

    // Wait long enough that the watcher has had time to process the file.
    await new Promise((r) => setTimeout(r, 200));
    expect(sendFileMock).not.toHaveBeenCalled();
    const rows = _getAllMessagesForChat('main@g.us');
    expect(rows.some((r) => r.content === 'should-not-deliver')).toBe(false);
  });

  it('non-main targeting its OWN chat is allowed (param accepted, normal send)', async () => {
    const fileName = 'own.txt';
    fs.writeFileSync(path.join(GROUPS_DIR, 'other-group', fileName), 'y');

    dropIpcMessage('other-group', {
      type: 'send_file',
      chatJid: 'other@g.us', // its own chat
      filePath: `/workspace/group/${fileName}`,
      caption: 'self-target',
      groupFolder: 'other-group',
      timestamp: new Date().toISOString(),
    });

    await waitFor(() => sendFileMock.mock.calls.length > 0, 2000);
    expect(sendFileMock.mock.calls[0][0]).toBe('other@g.us');
  });
});

describe('send_voice with chat_jid (issue #25)', () => {
  it('main can target another chat; sendVoice receives target jid and the spoken text is recorded there', async () => {
    dropIpcMessage('whatsapp_main', {
      type: 'send_voice',
      chatJid: 'other@g.us',
      text: 'hello cross chat',
      voice: 'alloy',
      groupFolder: 'whatsapp_main',
      timestamp: new Date().toISOString(),
    });

    await waitFor(() => sendVoiceMock.mock.calls.length > 0, 2000);
    const [jid, text] = sendVoiceMock.mock.calls[0];
    expect(jid).toBe('other@g.us');
    expect(text).toBe('hello cross chat');

    await waitFor(
      () =>
        _getAllMessagesForChat('other@g.us').some(
          (r) =>
            r.content === '[Voice: hello cross chat]' && r.is_bot_message === 1,
        ),
      2000,
    );
  });

  it('trusted/untrusted cross-chat send_voice is blocked', async () => {
    dropIpcMessage('other-group', {
      type: 'send_voice',
      chatJid: 'main@g.us',
      text: 'should-not-speak',
      voice: 'alloy',
      groupFolder: 'other-group',
      timestamp: new Date().toISOString(),
    });

    await new Promise((r) => setTimeout(r, 200));
    expect(sendVoiceMock).not.toHaveBeenCalled();
  });
});
