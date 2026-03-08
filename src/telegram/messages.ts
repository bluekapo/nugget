import type { MessageStore } from '../db/messages.js';
import { wrapPre } from '../output/html.js';
import { logError } from '../logging/logger.js';

const MAX_RESTORE = 20;
const DELETE_CHUNK_SIZE = 100;

export class MessageTracker {
  /** In-memory: sessionName -> [messageId, ...] (only output messages, never hub) */
  private messageIds: Map<string, number[]> = new Map();
  /** In-memory: messageId -> content (for persistence before deletion) */
  private messageContent: Map<number, string> = new Map();

  constructor(
    private api: {
      deleteMessages(chatId: number, messageIds: number[]): Promise<boolean>;
      sendMessage(chatId: number, text: string, opts?: unknown): Promise<{ message_id: number }>;
    },
    private chatId: number,
    private store: MessageStore,
  ) {}

  /** Track a message ID for a session. Optionally store its content for later persistence. */
  track(sessionName: string, messageId: number, content?: string): void {
    const ids = this.messageIds.get(sessionName) ?? [];
    ids.push(messageId);
    this.messageIds.set(sessionName, ids);
    if (content !== undefined) {
      this.messageContent.set(messageId, content);
    }
  }

  /** Update the content for a message ID. Used when a message reaches EFFECTIVE_LIMIT and its content is captured. */
  updateContent(_sessionName: string, messageId: number, content: string): void {
    this.messageContent.set(messageId, content);
  }

  /**
   * Persist all tracked messages + current sink state to SQLite, then delete from Telegram.
   * Clears in-memory tracked IDs for the session after completion.
   */
  async persistAndDelete(
    sessionName: string,
    outputSink: { getCurrentState(): { messageId: number; text: string } | null },
  ): Promise<void> {
    const trackedIds = this.messageIds.get(sessionName) ?? [];
    const sinkState = outputSink.getCurrentState();

    // Collect all IDs to delete from Telegram
    const allIds = [...trackedIds];

    // Save tracked messages to store with incrementing sequence_num
    let seq = 1;
    for (const id of trackedIds) {
      const content = this.messageContent.get(id) ?? '';
      // Skip empty content -- no point persisting blank messages
      if (content.trim().length === 0) continue;
      this.store.save(sessionName, id, content, seq++);
    }

    // Save current sink message if it exists and isn't already tracked
    if (sinkState && !trackedIds.includes(sinkState.messageId)) {
      this.store.save(sessionName, sinkState.messageId, sinkState.text, seq++);
      allIds.push(sinkState.messageId);
    }

    // Delete from Telegram in chunks of DELETE_CHUNK_SIZE
    for (let i = 0; i < allIds.length; i += DELETE_CHUNK_SIZE) {
      const chunk = allIds.slice(i, i + DELETE_CHUNK_SIZE);
      try {
        await this.api.deleteMessages(this.chatId, chunk);
      } catch (err) {
        logError('deleteMessages failed:', err);
      }
    }

    // Clear in-memory state for this session
    this.messageIds.delete(sessionName);
    for (const id of trackedIds) {
      this.messageContent.delete(id);
    }
  }

  /**
   * Restore messages from SQLite back to Telegram chat.
   * Caps to the last MAX_RESTORE messages. Cleans up old records after restoration.
   * Returns the last message state for restoreState(), or null if nothing to restore.
   */
  async restore(sessionName: string): Promise<{ messageId: number; text: string } | null> {
    const messages = this.store.getBySession(sessionName);
    if (messages.length === 0) return null;

    // Take last MAX_RESTORE messages
    const toRestore = messages.slice(-MAX_RESTORE);

    let lastState: { messageId: number; text: string } | null = null;

    for (const msg of toRestore) {
      // Skip empty content -- Telegram rejects <pre></pre> as "text must be non-empty"
      if (!msg.content || msg.content.trim().length === 0) continue;

      const result = await this.api.sendMessage(
        this.chatId,
        wrapPre(msg.content),
        { parse_mode: 'HTML' },
      );

      // Track the new message ID for this session
      this.track(sessionName, result.message_id);

      lastState = { messageId: result.message_id, text: msg.content };
    }

    // Clean up old persisted records (they now have new Telegram message IDs)
    this.store.deleteBySession(sessionName);

    return lastState;
  }

  /**
   * Archive a session's messages: persist + delete from Telegram, then mark as archived in SQLite.
   */
  async archive(
    sessionName: string,
    outputSink: { getCurrentState(): { messageId: number; text: string } | null },
  ): Promise<void> {
    await this.persistAndDelete(sessionName, outputSink);
    this.store.updateStatus(sessionName, 'archived');
  }
}
