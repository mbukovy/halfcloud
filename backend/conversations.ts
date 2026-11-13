import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { UIMessage } from 'ai';
import { z } from 'zod';
import { sanitizeGitHubWebhookMessages } from './github-webhook-context.js';

export const conversationMessagesSchema = z.array(z.object({
  id: z.string().min(1),
  role: z.enum(['system', 'user', 'assistant']),
  parts: z.array(z.any()),
}).passthrough()).min(1);

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface Conversation extends ConversationSummary {
  messages: UIMessage[];
  revision: number;
}

type ConversationRow = {
  id: string;
  title: string;
  messages_json: string;
  created_at: string;
  updated_at: string;
  revision: number;
};

function conversationTitle(messages: UIMessage[]) {
  const firstUserMessage = messages.find((message) => message.role === 'user');
  const text = firstUserMessage?.parts
    .flatMap((part) => typeof part === 'object' && part !== null && part.type === 'text' && typeof part.text === 'string' ? [part.text] : [])
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return 'New conversation';
  return text.length > 64 ? `${text.slice(0, 61).trimEnd()}...` : text;
}

export class ConversationStore {
  private readonly database: DatabaseSync;

  constructor(dataDir = process.env.HALFCLOUD_DATA_DIR ?? `${process.env.HOME ?? '/home/halfcloudrunner'}/.halfcloud/data`) {
    const directory = path.resolve(dataDir);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const databasePath = path.join(directory, 'halfcloud.sqlite');
    this.database = new DatabaseSync(databasePath);
    chmodSync(databasePath, 0o600);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        messages_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS conversations_recent ON conversations(updated_at DESC);
    `);
    const columns = this.database.prepare('PRAGMA table_info(conversations)').all();
    if (!columns.some((column) => column.name === 'revision')) {
      this.database.exec('ALTER TABLE conversations ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
    }
  }

  list(limit = 10): ConversationSummary[] {
    const rows = this.database.prepare(`
      SELECT id, title, created_at, updated_at
      FROM conversations
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(Math.max(1, Math.min(Math.floor(limit), 50))) as Array<Omit<ConversationRow, 'messages_json'>>;
    return rows.map((row) => ({ id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  get(id: string): Conversation | undefined {
    const row = this.database.prepare(`
      SELECT id, title, messages_json, created_at, updated_at, revision
      FROM conversations
      WHERE id = ?
    `).get(id) as ConversationRow | undefined;
    if (!row) return undefined;
    const messages = sanitizeGitHubWebhookMessages(conversationMessagesSchema.parse(JSON.parse(row.messages_json)) as UIMessage[]);
    return { id: row.id, title: row.title, messages, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  save(id: string, inputMessages: UIMessage[]): Conversation {
    const messages = sanitizeGitHubWebhookMessages(conversationMessagesSchema.parse(inputMessages) as UIMessage[]);
    if (!messages.some((message) => message.role === 'user')) throw new Error('A conversation requires a user message');
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO conversations (id, title, messages_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        messages_json = excluded.messages_json,
        updated_at = excluded.updated_at,
        revision = conversations.revision + 1
    `).run(id, conversationTitle(messages), JSON.stringify(messages), now, now);
    return this.get(id)!;
  }
  close() {
    this.database.close();
  }
}
