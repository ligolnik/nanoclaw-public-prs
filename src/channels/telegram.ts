import { execFile } from 'child_process';
import fs from 'fs';
import https from 'https';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { Api, Bot, InputFile } from 'grammy';

import {
  ASSISTANT_NAME,
  GROUPS_DIR,
  TRIGGER_PATTERN,
  getTriggerPattern,
} from '../config.js';
import { createDraftStream, DraftStream } from '../draft-stream.js';
import { getLatestMessage, getMessageById, storeReaction } from '../db.js';
import { noteLatestUserMessage } from '../observer.js';
import { readEnvFile } from '../env.js';

const execFileAsync = promisify(execFile);
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { sanitizeTelegramHtml } from './telegram-sanitize.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Send a message with Telegram HTML parse mode, falling back to plain text.
 * Supports: <b>bold</b>, <i>italic</i>, <s>strikethrough</s>, <u>underline</u>,
 * <code>inline code</code>, <pre>code blocks</pre>, <blockquote>quotes</blockquote>,
 * <a href="url">links</a>, <tg-spoiler>spoilers</tg-spoiler>
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: {
    message_thread_id?: number;
    reply_parameters?: { message_id: number };
  } = {},
): Promise<number | undefined> {
  // Idempotent Markdown→HTML pass — agents sometimes produce `**bold**` or
  // `[text](url)` despite being told to use HTML. Well-formed HTML passes
  // through unchanged; URLs/emails/existing tags are protected.
  const sanitized = sanitizeTelegramHtml(text);
  try {
    const msg = await api.sendMessage(chatId, sanitized, {
      ...options,
      parse_mode: 'HTML',
    });
    return msg.message_id;
  } catch (err) {
    // Fallback: HTML parsing failed — send the ORIGINAL text without
    // parse_mode. Sending `sanitized` here would render raw `<b>…</b>`
    // tags literally to the user, which is strictly worse than the raw
    // Markdown the agent produced.
    logger.debug({ err }, 'HTML send failed, falling back to plain text');
    const msg = await api.sendMessage(chatId, text, options);
    return msg.message_id;
  }
}

const MAX_LENGTH = 4096;

// Slack-style shortcode → Unicode mapping for the 73 Telegram-supported
// reactions (Bot API 7.x). Covers every entry in
// TELEGRAM_ALLOWED_REACTIONS below. Agents and skills emit shortcodes
// like `thumbs_up` or `:thumbs_up:` because that's the lingua franca
// across Slack/GitHub/GitLab/Mattermost; without normalization those
// shortcodes failed `TELEGRAM_ALLOWED_REACTIONS.has(...)` and fell
// back silently to 👍 — see #161 for the production sighting where
// only ~16 emoji worked via shortcode while ~57 silently failed.
//
// Multiple shortcodes can map to the same Unicode char where common
// aliases exist (e.g. both `+1` and `thumbs_up` → 👍).
//
// IMPORTANT: every value in this map MUST also exist in
// TELEGRAM_ALLOWED_REACTIONS. Drift between the two means a
// successfully-mapped shortcode would still fall back to 👍 at the
// allowed-reactions gate; the test suite enforces this invariant.
const EMOJI_SHORTCODE_TO_UNICODE: Record<string, string> = {
  // — affirmation & engagement
  thumbs_up: '👍',
  '+1': '👍',
  thumbsup: '👍',
  thumbs_down: '👎',
  '-1': '👎',
  thumbsdown: '👎',
  heart: '❤',
  red_heart: '❤',
  fire: '🔥',
  smiling_face_with_hearts: '🥰',
  smiling_face_with_3_hearts: '🥰',
  clap: '👏',
  beaming_face_with_smiling_eyes: '😁',
  grin: '😁',
  thinking_face: '🤔',
  thinking: '🤔',
  exploding_head: '🤯',
  shocked_face: '😱',
  scream: '😱',
  face_with_symbols_on_mouth: '🤬',
  cursing_face: '🤬',
  crying_face: '😢',
  cry: '😢',
  party_popper: '🎉',
  tada: '🎉',
  smiling_face_with_starry_eyes: '🤩',
  star_struck: '🤩',
  face_vomiting: '🤮',
  vomit: '🤮',
  pile_of_poo: '💩',
  poop: '💩',
  hankey: '💩',
  shit: '💩',
  folded_hands: '🙏',
  pray: '🙏',
  ok_hand: '👌',
  dove: '🕊',
  dove_of_peace: '🕊',
  clown_face: '🤡',
  clown: '🤡',
  yawning_face: '🥱',
  yawn: '🥱',
  woozy_face: '🥴',
  smiling_face_with_heart_eyes: '😍',
  heart_eyes: '😍',
  whale: '🐳',
  heart_on_fire: '❤‍🔥',
  new_moon_face: '🌚',
  new_moon_with_face: '🌚',
  hot_dog: '🌭',
  hotdog: '🌭',
  hundred_points: '💯',
  hundred: '💯',
  '100': '💯',
  rolling_on_the_floor_laughing: '🤣',
  rofl: '🤣',
  high_voltage: '⚡',
  zap: '⚡',
  banana: '🍌',
  trophy: '🏆',
  broken_heart: '💔',
  face_with_raised_eyebrow: '🤨',
  raised_eyebrow: '🤨',
  neutral_face: '😐',
  strawberry: '🍓',
  bottle_with_popping_cork: '🍾',
  champagne: '🍾',
  kiss_mark: '💋',
  kiss: '💋',
  middle_finger: '🖕',
  fu: '🖕',
  smiling_face_with_horns: '😈',
  smiling_imp: '😈',
  sleeping_face: '😴',
  sleeping: '😴',
  loudly_crying_face: '😭',
  sob: '😭',
  nerd_face: '🤓',
  nerd: '🤓',
  ghost: '👻',
  technologist: '👨‍💻',
  man_technologist: '👨‍💻',
  eyes: '👀',
  jack_o_lantern: '🎃',
  see_no_evil: '🙈',
  see_no_evil_monkey: '🙈',
  smiling_face_with_halo: '😇',
  innocent: '😇',
  fearful_face: '😨',
  fearful: '😨',
  handshake: '🤝',
  writing_hand: '✍',
  pencil: '✍',
  smiling_face_with_open_hands: '🤗',
  hugs: '🤗',
  saluting_face: '🫡',
  salute: '🫡',
  santa_claus: '🎅',
  santa: '🎅',
  christmas_tree: '🎄',
  snowman: '☃',
  nail_polish: '💅',
  zany_face: '🤪',
  zany: '🤪',
  moai: '🗿',
  cool: '🆒',
  heart_with_arrow: '💘',
  cupid: '💘',
  hear_no_evil: '🙉',
  hear_no_evil_monkey: '🙉',
  unicorn: '🦄',
  unicorn_face: '🦄',
  face_blowing_a_kiss: '😘',
  kissing_heart: '😘',
  pill: '💊',
  speak_no_evil: '🙊',
  speak_no_evil_monkey: '🙊',
  smiling_face_with_sunglasses: '😎',
  sunglasses: '😎',
  alien_monster: '👾',
  space_invader: '👾',
  man_shrugging: '🤷‍♂',
  shrug: '🤷',
  person_shrugging: '🤷',
  woman_shrugging: '🤷‍♀',
  pouting_face: '😡',
  enraged: '😡',
  rage: '😡',
};

/**
 * Normalize a reaction emoji input to a Telegram-supported Unicode
 * character, accepting both shortcodes (`thumbs_up`, `:thumbs_up:`)
 * and raw Unicode (`👍`, `❤️`). Returns the input unchanged if it
 * can't be mapped; the caller (`sendReaction`) then runs the
 * TELEGRAM_ALLOWED_REACTIONS gate, which falls back to 👍 with a
 * warn log so unmapped inputs are visible rather than silently
 * accepted.
 *
 * Strips:
 *   - U+FE0F (variation selector 16) so emoji-presentation forms
 *     like `❤️`, `☃️`, `✍️`, `🤷‍♂️` match the no-VS16 entries in
 *     TELEGRAM_ALLOWED_REACTIONS. Telegram's reaction set uses the
 *     bare codepoints; agents and clients commonly emit the
 *     VS16-suffixed form.
 *   - Surrounding `:` so both `thumbs_up` and `:thumbs_up:` map —
 *     Slack-style colon delimiters are common in agent output.
 */
export function normalizeReactionEmoji(input: string): string {
  // Strip U+FE0F (VARIATION SELECTOR-16). Written as the explicit
  // `\uFE0F` escape — an invisible literal in the regex source is
  // hard to audit and trivially altered by editor reformatting.
  const noVS16 = input.replace(/\uFE0F/g, '');
  if (TELEGRAM_ALLOWED_REACTIONS.has(noVS16)) return noVS16;
  const stripped = noVS16.replace(/^:|:$/g, '');
  // Guard against prototype pollution: indexing a plain object with
  // a string like `toString` / `__proto__` returns an inherited
  // value (function / object) from Object.prototype, not undefined.
  // Object.hasOwn restricts the lookup to own properties so the
  // function's string-or-input contract holds for any input.
  const fromShortcode = Object.hasOwn(EMOJI_SHORTCODE_TO_UNICODE, stripped)
    ? EMOJI_SHORTCODE_TO_UNICODE[stripped]
    : undefined;
  return fromShortcode ?? input;
}

/**
 * Predicate exposed for tests so the drift invariant between
 * EMOJI_SHORTCODE_TO_UNICODE and TELEGRAM_ALLOWED_REACTIONS can be
 * asserted without exporting the Set itself. Returns true iff the
 * given Unicode emoji is in Telegram's accepted reaction set.
 *
 * @internal
 */
export function _isAllowedReaction(emoji: string): boolean {
  return TELEGRAM_ALLOWED_REACTIONS.has(emoji);
}

/**
 * The shortcode → Unicode map exposed for tests so the drift
 * invariant (every value is in TELEGRAM_ALLOWED_REACTIONS) can be
 * asserted exhaustively rather than against a hardcoded list.
 *
 * @internal
 */
export const _EMOJI_SHORTCODE_TO_UNICODE = EMOJI_SHORTCODE_TO_UNICODE;

// Telegram's allowed reaction emoji (as of Bot API 7.x)
const TELEGRAM_ALLOWED_REACTIONS = new Set([
  '👍',
  '👎',
  '❤',
  '🔥',
  '🥰',
  '👏',
  '😁',
  '🤔',
  '🤯',
  '😱',
  '🤬',
  '😢',
  '🎉',
  '🤩',
  '🤮',
  '💩',
  '🙏',
  '👌',
  '🕊',
  '🤡',
  '🥱',
  '🥴',
  '😍',
  '🐳',
  '❤‍🔥',
  '🌚',
  '🌭',
  '💯',
  '🤣',
  '⚡',
  '🍌',
  '🏆',
  '💔',
  '🤨',
  '😐',
  '🍓',
  '🍾',
  '💋',
  '🖕',
  '😈',
  '😴',
  '😭',
  '🤓',
  '👻',
  '👨‍💻',
  '👀',
  '🎃',
  '🙈',
  '😇',
  '😨',
  '🤝',
  '✍',
  '🤗',
  '🫡',
  '🎅',
  '🎄',
  '☃',
  '💅',
  '🤪',
  '🗿',
  '🆒',
  '💘',
  '🙉',
  '🦄',
  '😘',
  '💊',
  '🙊',
  '😎',
  '👾',
  '🤷‍♂',
  '🤷',
  '🤷‍♀',
  '😡',
]);

/**
 * Split text into chunks that respect content boundaries.
 * Priority: code block boundaries > double newline (paragraph) > single newline > space > hard cut.
 */
export function splitMessage(text: string): string[] {
  if (text.length <= MAX_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > MAX_LENGTH) {
    let splitAt = -1;

    // 1. Try to split at a code block boundary (``` on its own line)
    const codeBlockPattern = /\n```\n/g;
    let match;
    while ((match = codeBlockPattern.exec(remaining)) !== null) {
      const pos = match.index + match[0].length;
      if (pos <= MAX_LENGTH && pos > splitAt) {
        splitAt = pos;
      }
    }

    // 2. Try to split at a paragraph boundary (double newline)
    if (splitAt === -1) {
      const lastParagraph = remaining.lastIndexOf('\n\n', MAX_LENGTH);
      if (lastParagraph > MAX_LENGTH * 0.3) {
        splitAt = lastParagraph + 2;
      }
    }

    // 3. Try to split at a single newline
    if (splitAt === -1) {
      const lastNewline = remaining.lastIndexOf('\n', MAX_LENGTH);
      if (lastNewline > MAX_LENGTH * 0.3) {
        splitAt = lastNewline + 1;
      }
    }

    // 4. Try to split at a space
    if (splitAt === -1) {
      const lastSpace = remaining.lastIndexOf(' ', MAX_LENGTH);
      if (lastSpace > MAX_LENGTH * 0.3) {
        splitAt = lastSpace + 1;
      }
    }

    // 5. Hard cut (last resort)
    if (splitAt === -1) {
      splitAt = MAX_LENGTH;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

/**
 * Truncate a string to a maximum length, appending "..." if truncated.
 */
function truncate(s: string, max = 120): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

/**
 * Resolve a Telegram reply context: look up the replied-to message in the DB
 * and return a prefix string with the quoted content.
 * Falls back to the reply message text if DB lookup fails (common for bot messages
 * whose DB id doesn't match Telegram message_id).
 */
function resolveReply(
  replyMsg: {
    message_id: number;
    text?: string;
    caption?: string;
    from?: { first_name?: string };
  },
  chatJid: string,
): string {
  // Try DB lookup first
  const original = getMessageById(replyMsg.message_id.toString(), chatJid);
  if (original) {
    return `[Replying to ${original.sender_name}: "${truncate(original.content, 200)}"]\n`;
  }
  // Fall back to the reply message text directly from Telegram
  const text = replyMsg.text || replyMsg.caption;
  if (text) {
    const sender = replyMsg.from?.first_name || 'Unknown';
    return `[Replying to ${sender}: "${truncate(text, 200)}"]\n`;
  }
  return '';
}

/**
 * Resolve t.me/c/<chat_id>/<message_id> links in content.
 * Replaces each link with `[Message: "<content>"]` if found in DB.
 */
function resolveMessageLinks(content: string): string {
  return content.replace(
    /https?:\/\/t\.me\/c\/(\d+)\/(\d+)/g,
    (_match, rawChatId, msgId) => {
      // Telegram supergroup JID: URL chat_id is bare id without -100 prefix
      const candidateJids = [`tg:-100${rawChatId}`, `tg:${rawChatId}`];
      for (const jid of candidateJids) {
        const msg = getMessageById(msgId, jid);
        if (msg) return `[Message: "${truncate(msg.content)}"]`;
      }
      return `[Message: not found]`;
    },
  );
}

/**
 * Download a file from Telegram's file API.
 * Returns a Buffer with the file contents.
 */
async function downloadTelegramFile(bot: Bot, fileId: string): Promise<Buffer> {
  const file = await bot.api.getFile(fileId);
  const filePath = file.file_path!;
  const token = bot.token;
  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;

  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
  });
}

/**
 * Save a Telegram document to the group's workspace and return the container path.
 */
async function saveDocument(
  bot: Bot,
  fileId: string,
  fileName: string,
  groupFolder: string,
): Promise<string | null> {
  try {
    const buffer = await downloadTelegramFile(bot, fileId);
    const docsDir = path.join(GROUPS_DIR, groupFolder, 'documents');
    fs.mkdirSync(docsDir, { recursive: true });
    // Prefix with timestamp to avoid collisions
    const safeName = `${Date.now()}-${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const filePath = path.join(docsDir, safeName);
    fs.writeFileSync(filePath, buffer);
    logger.info(
      { groupFolder, fileName: safeName, size: buffer.length },
      'Saved Telegram document',
    );
    return `/workspace/group/documents/${safeName}`;
  } catch (err) {
    logger.error({ err, fileName }, 'Failed to save Telegram document');
    return null;
  }
}

/**
 * Transcribe a voice message using OpenAI Whisper, routed via OneCLI.
 *
 * No API key in .env: the request is wrapped in `onecli run`, which sets
 * HTTPS_PROXY to the OneCLI gateway. OneCLI matches the request against
 * the user's stored generic secret for `api.openai.com` and injects
 * `Authorization: Bearer <key>` transparently. If OneCLI has no matching
 * credential or the host has no `onecli` binary, transcription returns
 * null and the rest of the message flow continues normally.
 *
 * The audio is written to a temp file because Whisper's endpoint is
 * multipart/form-data — easiest to do with `curl -F file=@...`.
 */
async function transcribeVoice(audioBuffer: Buffer): Promise<string | null> {
  const tmpFile = path.join(os.tmpdir(), `voice-${Date.now()}.ogg`);
  try {
    fs.writeFileSync(tmpFile, audioBuffer);
    const { stdout, stderr } = await execFileAsync(
      'onecli',
      [
        'run',
        '--',
        'curl',
        '-sS',
        '-X',
        'POST',
        'https://api.openai.com/v1/audio/transcriptions',
        '-F',
        `file=@${tmpFile}`,
        '-F',
        'model=whisper-1',
        '-F',
        'response_format=json',
      ],
      { timeout: 30_000 },
    );
    // Strip OneCLI's stderr-prefix line ("onecli: gateway connected. ...").
    let body = stdout.trim();
    // OneCLI prints status to stderr; in practice some installs send it to
    // stdout. Be defensive — find the JSON object.
    const jsonStart = body.indexOf('{');
    if (jsonStart > 0) body = body.slice(jsonStart);
    const parsed = JSON.parse(body);
    if (parsed.error) {
      logger.error(
        { err: parsed.error, stderr: stderr?.slice(0, 200) },
        'Whisper transcription returned error',
      );
      return null;
    }
    return typeof parsed.text === 'string' ? parsed.text : null;
  } catch (err) {
    logger.error({ err }, 'OneCLI/Whisper transcription failed');
    return null;
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Save a Telegram photo to the group's workspace and return the file path.
 * Downloads the highest-resolution version of the photo.
 */
async function savePhoto(
  bot: Bot,
  photoSizes: Array<{ file_id: string; width: number; height: number }>,
  groupFolder: string,
): Promise<string | null> {
  try {
    // Pick the largest photo
    const largest = photoSizes.reduce((a, b) =>
      a.width * a.height > b.width * b.height ? a : b,
    );
    const buffer = await downloadTelegramFile(bot, largest.file_id);
    const imagesDir = path.join(GROUPS_DIR, groupFolder, 'images');
    fs.mkdirSync(imagesDir, { recursive: true });
    const filename = `${Date.now()}.jpg`;
    const filePath = path.join(imagesDir, filename);
    fs.writeFileSync(filePath, buffer);
    logger.info(
      { groupFolder, filename, size: buffer.length },
      'Saved Telegram photo',
    );
    return `/workspace/group/images/${filename}`;
  } catch (err) {
    logger.error({ err }, 'Failed to save Telegram photo');
    return null;
  }
}

// Bot pool for agent teams: send-only Api instances (no polling)
const poolApis: Api[] = [];
// Maps "{groupFolder}:{senderName}" → pool Api index for stable assignment
const senderBotMap = new Map<string, number>();
let nextPoolIndex = 0;

/**
 * Initialize send-only Api instances for the bot pool.
 * Each pool bot can send messages but doesn't poll for updates.
 */
export async function initBotPool(tokens: string[]): Promise<void> {
  for (const token of tokens) {
    try {
      const api = new Api(token);
      const me = await api.getMe();
      poolApis.push(api);
      logger.info(
        { username: me.username, id: me.id, poolSize: poolApis.length },
        'Pool bot initialized',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to initialize pool bot');
    }
  }
  if (poolApis.length > 0) {
    logger.info({ count: poolApis.length }, 'Telegram bot pool ready');
  }
}

/**
 * Send a message via a pool bot assigned to the given sender name.
 * Assigns bots round-robin on first use; subsequent messages from the
 * same sender in the same group always use the same bot.
 * On first assignment, renames the bot to match the sender's role.
 */
export async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  groupFolder: string,
): Promise<void> {
  if (poolApis.length === 0) {
    // No pool bots — fall back to main bot sendMessage via channel
    return;
  }

  const key = `${groupFolder}:${sender}`;
  let idx = senderBotMap.get(key);
  if (idx === undefined) {
    idx = nextPoolIndex % poolApis.length;
    nextPoolIndex++;
    senderBotMap.set(key, idx);
    // Rename the bot to match the sender's role, then wait for Telegram to propagate
    try {
      await poolApis[idx].setMyName(sender);
      await new Promise((r) => setTimeout(r, 2000));
      logger.info(
        { sender, groupFolder, poolIndex: idx },
        'Assigned and renamed pool bot',
      );
    } catch (err) {
      logger.warn(
        { sender, err },
        'Failed to rename pool bot (sending anyway)',
      );
    }
  }

  const api = poolApis[idx];
  try {
    const numericId = chatId.replace(/^tg:/, '');
    const chunks = splitMessage(text);
    for (const chunk of chunks) {
      await sendTelegramMessage(api, numericId, chunk);
    }
    logger.info(
      {
        chatId,
        sender,
        poolIndex: idx,
        length: text.length,
        chunks: chunks.length,
      },
      'Pool message sent',
    );
  } catch (err) {
    logger.error({ chatId, sender, err }, 'Failed to send pool message');
  }
}

/**
 * Build sender display name with @username if available.
 * e.g. "JBáruch (@jbaruch)" or "Unknown" if no info.
 */
function buildSenderName(from?: {
  first_name?: string;
  username?: string;
  id?: number;
}): string {
  const displayName =
    from?.first_name || from?.username || from?.id?.toString() || 'Unknown';
  return from?.username ? `${displayName} (@${from.username})` : displayName;
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: <code>tg:${chatId}</code>\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'HTML' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Telegram bot commands handled above — skip them in the general handler
    // so they don't also get stored as messages. All other /commands flow through.
    const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName = buildSenderName(ctx.from);
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();
      const threadId = ctx.message.message_thread_id;

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Resolve reply context — include quoted message content for the agent
      const replyTo = ctx.message.reply_to_message;
      if (replyTo) {
        const prefix = resolveReply(replyTo, chatJid);
        if (prefix) content = prefix + content;
      }

      // Handle Telegram's quote feature (selected text excerpt)
      if (ctx.message.quote?.text) {
        content = `[Quoted: "${truncate(ctx.message.quote.text, 300)}"]\n${content}`;
      }

      // Resolve t.me/c message links
      content = resolveMessageLinks(content);

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        thread_id: threadId ? threadId.toString() : undefined,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );

      // Host-side auto-ack: react 👀 immediately so the user sees the
      // message was received. The observer then updates this reaction as
      // the agent progresses (🤔 thinking → ⚡ tools → ✍ replying).
      // setMessageReaction is single-emoji per bot per message, so each
      // update replaces the prior one.
      //
      // Gating: the host knows a message arrived but has no context on
      // the sender. In untrusted chats the agent's bad-actor-disengage
      // rule may decide to go silent (no text, no reaction) — host-side
      // auto-react would leak a "I see you" signal before that rule ever
      // ran. So we only auto-react in trust contexts where engagement is
      // already guaranteed: main and trusted groups where the trigger
      // matched. For untrusted, the agent itself decides whether to
      // react (after reading the message and applying its rules).
      const requiresTrigger = group.requiresTrigger !== false && !group.isMain;
      const triggerHit =
        !requiresTrigger ||
        getTriggerPattern(group.trigger).test(content.trim()) ||
        !!ctx.message.reply_to_message?.from?.is_bot;
      if ((group.isMain || group.containerConfig?.trusted) && triggerHit) {
        this.sendReaction(chatJid, msgId, '👀').catch(() => {
          /* already logged */
        });
        noteLatestUserMessage(chatJid, msgId);
      }
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName = buildSenderName(ctx.from);
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName = buildSenderName(ctx.from);
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      const isTrustedPhoto = group.isMain || !!group.containerConfig?.trusted;
      let placeholder: string;
      if (isTrustedPhoto) {
        const containerPath = await savePhoto(
          this.bot!,
          ctx.message.photo,
          group.folder,
        );
        placeholder = containerPath
          ? `[Image: ${containerPath}]`
          : '[Image - download failed]';
      } else {
        placeholder = '[Image]';
      }

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
      logger.info(
        { chatJid, senderName, placeholder },
        'Telegram photo stored',
      );
    });

    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));

    this.bot.on('message:voice', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName = buildSenderName(ctx.from);
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      let content: string;
      try {
        const buffer = await downloadTelegramFile(
          this.bot!,
          ctx.message.voice.file_id,
        );
        const transcript = await transcribeVoice(buffer);
        content = transcript
          ? `[Voice: ${transcript}]`
          : '[Voice message - transcription unavailable]';
        if (transcript) {
          logger.info(
            { chatJid, senderName, chars: transcript.length },
            'Transcribed voice message',
          );
          // Voice messages can't carry an @mention. In trigger-required
          // groups, infer intent: if the user said the bot's name OR the
          // assistant's name in the transcript, prepend the trigger so the
          // routing layer treats the voice as addressed to the bot.
          // Mirrors the `@limlombot` → `@${ASSISTANT_NAME}` rewrite that
          // text messages already get.
          const botUsername = ctx.me?.username?.toLowerCase();
          const lowered = transcript.toLowerCase();
          const named =
            (botUsername && lowered.includes(botUsername)) ||
            lowered.includes(ASSISTANT_NAME.toLowerCase()) ||
            lowered.includes('lom bot') ||
            lowered.includes('lim lom') ||
            lowered.includes('lim-lom');
          if (named && !TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      } catch (err) {
        logger.error({ err }, 'Failed to process voice message');
        content = '[Voice message - transcription failed]';
      }

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    });
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName = buildSenderName(ctx.from);
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      const fileName = ctx.message.document?.file_name || 'file';
      const fileId = ctx.message.document?.file_id;
      const isTrusted = group.isMain || !!group.containerConfig?.trusted;
      let content: string;

      if (fileId && isTrusted) {
        const containerPath = await saveDocument(
          this.bot!,
          fileId,
          fileName,
          group.folder,
        );
        content = containerPath
          ? `[Document: ${containerPath}]${caption}`
          : `[Document: ${fileName} - download failed]${caption}`;
        if (containerPath) {
          logger.info(
            { chatJid, senderName, containerPath },
            'Telegram document stored',
          );
        }
      } else if (fileId && !isTrusted) {
        content = `[Document: ${fileName}]${caption}`;
      } else {
        content = `[Document: ${fileName} - no file_id]${caption}`;
      }

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle emoji reactions
    this.bot.on('message_reaction', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const update = ctx.messageReaction;
      const reactorId = update.user?.id?.toString() || '';
      const reactorName =
        update.user?.first_name || update.user?.username || 'Unknown';
      const timestamp = new Date(update.date * 1000).toISOString();

      for (const reaction of update.new_reaction || []) {
        if (reaction.type === 'emoji') {
          storeReaction({
            message_id: update.message_id.toString(),
            message_chat_jid: chatJid,
            reactor_jid: `${reactorId}@telegram`,
            reactor_name: reactorName,
            emoji: reaction.emoji,
            timestamp,
          });
          logger.info(
            { chatJid, reactorName, emoji: reaction.emoji },
            'Telegram reaction stored',
          );
        }
      }
    });

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling with auto-restart on transient failures (e.g. 409 Conflict).
    // Grammy's polling loop dies silently on getUpdates errors — we catch that
    // and restart after a backoff so the bot doesn't go deaf.
    const MAX_POLLING_RETRIES = 5;
    let pollingRetries = 0;

    const startPolling = (): Promise<void> => {
      return new Promise<void>((resolve, reject) => {
        let resolved = false;
        this.bot!.start({
          onStart: (botInfo) => {
            logger.info(
              { username: botInfo.username, id: botInfo.id },
              'Telegram bot connected',
            );
            console.log(`\n  Telegram bot: @${botInfo.username}`);
            console.log(
              `  Send /chatid to the bot to get a chat's registration ID\n`,
            );
            pollingRetries = 0; // reset on successful start
            if (!resolved) {
              resolved = true;
              resolve();
            }
          },
        }).catch((err: Error) => {
          pollingRetries++;
          if (pollingRetries > MAX_POLLING_RETRIES) {
            logger.fatal(
              { err: err.message, retries: pollingRetries },
              'Telegram polling failed too many times, giving up',
            );
            if (!resolved) {
              resolved = true;
              reject(err);
            }
            return;
          }
          const backoffMs = Math.min(10_000 * pollingRetries, 60_000);
          logger.error(
            { err: err.message, retry: pollingRetries, backoffMs },
            'Telegram polling loop crashed, restarting',
          );
          setTimeout(() => {
            logger.info(
              { retry: pollingRetries },
              'Restarting Telegram polling loop',
            );
            startPolling().catch((retryErr: Error) => {
              logger.error(
                { err: retryErr.message },
                'Telegram polling restart failed',
              );
            });
          }, backoffMs);
          // Only reject if we haven't resolved the initial start yet
          if (!resolved) {
            resolved = true;
            reject(err);
          }
        });
      });
    };

    return startPolling();
  }

  async sendMessage(
    jid: string,
    text: string,
    replyToMessageId?: string,
  ): Promise<string | void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const options: {
        message_thread_id?: number;
        reply_parameters?: { message_id: number };
      } = {};

      if (replyToMessageId) {
        options.reply_parameters = {
          message_id: parseInt(replyToMessageId, 10),
        };
      }

      // Split respecting content boundaries (code blocks, paragraphs, etc.)
      const chunks = splitMessage(text);
      let lastMsgId: number | undefined;
      for (let i = 0; i < chunks.length; i++) {
        const chunkOptions = i === 0 ? options : {};
        lastMsgId = await sendTelegramMessage(
          this.bot.api,
          numericId,
          chunks[i],
          chunkOptions,
        );
      }
      logger.info(
        { jid, length: text.length, replyToMessageId, chunks: chunks.length },
        'Telegram message sent',
      );
      return lastMsgId?.toString();
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  async sendFile(
    jid: string,
    filePath: string,
    caption?: string,
    replyToMessageId?: string,
  ): Promise<void> {
    if (!this.bot) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      // Sanitize the caption same as `sendTelegramMessage` does for text:
      // Markdown → HTML, then parse_mode: 'HTML'. Without this, an agent
      // that invokes `mcp__nanoclaw__send_file` with a Markdown caption
      // gets the Markdown rendered literally on Telegram — and bypasses
      // our sanitizer entirely. Captions previously shipped as plain text
      // with no parse_mode, so `_heartbeat_` rendered as `_heartbeat_`.
      const sanitizedCaption = caption
        ? sanitizeTelegramHtml(caption)
        : undefined;
      const options: {
        caption?: string;
        parse_mode?: 'HTML';
        reply_parameters?: { message_id: number };
      } = {};
      if (sanitizedCaption) {
        options.caption = sanitizedCaption;
        options.parse_mode = 'HTML';
      }
      if (replyToMessageId) {
        options.reply_parameters = {
          message_id: parseInt(replyToMessageId, 10),
        };
      }
      try {
        await this.bot.api.sendDocument(
          numericId,
          new InputFile(filePath),
          options,
        );
      } catch (err) {
        // Fallback only makes sense when the first attempt used
        // `parse_mode: 'HTML'` — i.e. a caption was provided and
        // sanitized. Without that, the retry payload would be
        // identical to the first attempt, so retrying just doubles
        // API traffic on transient/network failures. Let the error
        // bubble to the outer catch/logger instead.
        if (options.parse_mode !== 'HTML') throw err;
        // Mirror sendTelegramMessage's fallback: if HTML parse fails on the
        // caption, resend with the ORIGINAL caption and no parse_mode. Raw
        // text is strictly better than literal `<b>…</b>` tags in the UI.
        logger.debug(
          { err },
          'HTML caption parse failed, falling back to plain caption',
        );
        const plainOptions: {
          caption?: string;
          reply_parameters?: { message_id: number };
        } = {};
        if (caption) plainOptions.caption = caption;
        if (replyToMessageId) {
          plainOptions.reply_parameters = {
            message_id: parseInt(replyToMessageId, 10),
          };
        }
        await this.bot.api.sendDocument(
          numericId,
          new InputFile(filePath),
          plainOptions,
        );
      }
      logger.info({ jid, filePath, caption }, 'Telegram file sent');
    } catch (err) {
      logger.error({ jid, filePath, err }, 'Failed to send Telegram file');
    }
  }

  /**
   * Synthesize text → speech via OpenAI TTS (routed through OneCLI proxy
   * so no API key sits in the bot env), then upload to Telegram as a
   * voice note via `sendVoice`. Audio is OGG/Opus, the Telegram-native
   * format for voice — Telegram displays it as a real voice message
   * (waveform + scrubber + play speed), not a generic audio attachment.
   */
  async sendVoice(
    jid: string,
    text: string,
    voice: string,
    replyToMessageId?: string,
  ): Promise<void> {
    if (!this.bot) return;
    const tmpFile = path.join(os.tmpdir(), `tts-${Date.now()}.ogg`);
    try {
      // OpenAI TTS endpoint, called through OneCLI which injects
      // Authorization: Bearer <openai-key>. response_format=opus produces
      // the codec Telegram expects in a .ogg container. -o writes the
      // raw audio bytes directly to disk.
      const body = JSON.stringify({
        model: 'tts-1',
        voice,
        input: text,
        response_format: 'opus',
      });
      await execFileAsync(
        'onecli',
        [
          'run',
          '--',
          'curl',
          '-sS',
          '-X',
          'POST',
          'https://api.openai.com/v1/audio/speech',
          '-H',
          'Content-Type: application/json',
          '-d',
          body,
          '-o',
          tmpFile,
        ],
        { timeout: 60_000 },
      );
      if (!fs.existsSync(tmpFile) || fs.statSync(tmpFile).size === 0) {
        throw new Error('TTS produced no audio');
      }
      const numericId = jid.replace(/^tg:/, '');
      const opts: { reply_parameters?: { message_id: number } } = {};
      if (replyToMessageId) {
        opts.reply_parameters = { message_id: parseInt(replyToMessageId, 10) };
      }
      await this.bot.api.sendVoice(numericId, new InputFile(tmpFile), opts);
      logger.info({ jid, chars: text.length, voice }, 'Telegram voice sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram voice');
      throw err;
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        /* ignore */
      }
    }
  }

  async pinMessage(jid: string, messageId: string): Promise<void> {
    if (!this.bot) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.pinChatMessage(numericId, parseInt(messageId, 10));
      logger.info({ jid, messageId }, 'Telegram message pinned');
    } catch (err) {
      logger.error({ jid, messageId, err }, 'Failed to pin Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async isPrivateChat(jid: string): Promise<boolean> {
    if (!this.bot) return false;
    const numericId = jid.replace(/^tg:/, '');
    // Telegram getChat returns type ∈ {private, group, supergroup, channel}.
    // Only "private" (a 1:1 DM with the bot) is safe for the observer
    // chat — the other three types have multiple readers, including
    // potentially-untrusted external participants.
    const chat = await this.bot.api.getChat(numericId);
    return chat.type === 'private';
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }

  async sendReaction(
    jid: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    if (!this.bot) return;
    const numericId = jid.replace(/^tg:/, '');
    const msgId = parseInt(messageId, 10);
    // Telegram only allows specific emoji as reactions. Normalize
    // shortcodes (`thumbs_up`, `:thumbs_up:`) to Unicode first so
    // agents that emit Slack-style names don't silently fall back
    // to 👍 — see #161.
    const normalized = normalizeReactionEmoji(emoji);
    const reactionAllowed = TELEGRAM_ALLOWED_REACTIONS.has(normalized);
    const validEmoji = reactionAllowed ? normalized : '👍';
    if (!reactionAllowed) {
      // Real recoverable issue — caller asked for an emoji Telegram
      // doesn't support, we're substituting 👍 silently from the
      // user's perspective. Operators want to see this.
      logger.warn(
        {
          jid,
          messageId,
          requested: emoji,
          normalized,
          using: validEmoji,
        },
        'Invalid Telegram reaction emoji, falling back to 👍',
      );
    } else if (normalized !== emoji) {
      // Successful normalization (shortcode → Unicode, or VS16
      // strip). Not a problem — log at debug so production logs
      // aren't flooded when agents commonly emit shortcodes.
      logger.debug(
        { jid, messageId, requested: emoji, normalized },
        'Telegram reaction emoji normalized to Unicode',
      );
    }
    try {
      await this.bot.api.raw.setMessageReaction({
        chat_id: numericId,
        message_id: msgId,
        reaction: [{ type: 'emoji', emoji: validEmoji as any }],
      });
      // Store outbound reaction so unanswered-message checks see it
      storeReaction({
        message_id: messageId,
        message_chat_jid: jid,
        reactor_jid: 'bot@telegram',
        reactor_name: ASSISTANT_NAME,
        emoji: validEmoji,
        timestamp: new Date().toISOString(),
      });
      logger.info(
        { jid, messageId, emoji: validEmoji },
        'Telegram reaction sent',
      );
    } catch (err) {
      logger.error(
        { jid, messageId, emoji: validEmoji, err },
        'Failed to send Telegram reaction',
      );
    }
  }

  async reactToLatestMessage(jid: string, emoji: string): Promise<void> {
    const latest = getLatestMessage(jid);
    if (!latest) {
      logger.warn({ jid }, 'No messages found to react to');
      return;
    }
    await this.sendReaction(jid, latest.id, emoji);
  }

  createDraftStream(jid: string, replyToMessageId?: string): DraftStream {
    const numericId = jid.replace(/^tg:/, '');
    return createDraftStream({
      sendMessage: async (text) => {
        const opts: Record<string, unknown> = {};
        if (replyToMessageId) {
          opts.reply_parameters = {
            message_id: parseInt(replyToMessageId, 10),
          };
        }
        const msg = await this.bot!.api.sendMessage(numericId, text, opts);
        return msg.message_id;
      },
      editMessage: async (messageId, text) => {
        await this.bot!.api.editMessageText(numericId, messageId, text);
      },
      deleteMessage: async (messageId) => {
        await this.bot!.api.deleteMessage(numericId, messageId);
      },
      throttleMs: 1000,
      maxLength: 4096,
      minInitialChars: 30,
    });
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
