import type { AgentEvent } from './types';

/**
 * Translator for the Claude Code stream-json dialect: newline-delimited
 * `system`/`assistant`/`user`/`result` envelopes plus (with
 * `--include-partial-messages`) `stream_event` delta wrappers. Shared by
 * the claude, qwen, and codebuddy adapters — all three CLIs speak this
 * shape (qwen's init line uses subtype `session_start` instead of `init`).
 */

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
  [key: string]: unknown;
}

interface RawEnvelope {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  cwd?: string;
  /** stream_event envelope: the raw API event lives here. */
  event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string } };
  /** assistant / user message envelope. */
  message?: { content?: ContentBlock | ContentBlock[] };
  /** result event. */
  result?: string;
  is_error?: boolean;
  usage?: { input_tokens?: number; output_tokens?: number };
  total_cost_usd?: number;
  [key: string]: unknown;
}

/**
 * Dedupe state shared across one run's events: with
 * `--include-partial-messages` Claude Code emits both stream_event deltas
 * and the complete assistant message. Deltas for a message arrive before
 * its complete message, so once a delta was emitted we skip the complete
 * message's text/thinking blocks (tool_use blocks still come from the
 * complete message — partial tool inputs aren't usable).
 */
export interface ClaudeTranslatorState {
  /** Text/thinking of the in-flight assistant message was already streamed. */
  partialEmitted: boolean;
}

export function createClaudeTranslatorState(): ClaudeTranslatorState {
  return { partialEmitted: false };
}

export function* translateClaudeEvent(
  raw: unknown,
  state: ClaudeTranslatorState,
): Generator<AgentEvent> {
  if (!raw || typeof raw !== 'object') return;
  const evt = raw as RawEnvelope;

  if (evt.type === 'system' && (evt.subtype === 'init' || evt.subtype === 'session_start')) {
    yield { type: 'system', sessionId: evt.session_id, model: evt.model, cwd: evt.cwd };
    return;
  }

  if (evt.type === 'stream_event' && evt.event?.type === 'content_block_delta') {
    const delta = evt.event.delta;
    if (!delta) return;
    if (delta.type === 'text_delta' && delta.text) {
      state.partialEmitted = true;
      yield { type: 'text', delta: delta.text };
    } else if (delta.type === 'thinking_delta' && delta.thinking) {
      state.partialEmitted = true;
      yield { type: 'thinking', delta: delta.thinking };
    }
    return;
  }

  if (evt.type === 'assistant' && evt.message) {
    for (const block of asBlocks(evt.message.content)) {
      if (block.type === 'text') {
        if (!state.partialEmitted && block.text) yield { type: 'text', delta: block.text };
      } else if (block.type === 'thinking') {
        if (!state.partialEmitted && block.thinking) {
          yield { type: 'thinking', delta: block.thinking };
        }
      } else if (block.type === 'tool_use' && block.id) {
        yield { type: 'tool_use', id: block.id, name: block.name ?? 'tool', input: block.input ?? {} };
      }
    }
    state.partialEmitted = false;
    return;
  }

  if (evt.type === 'user' && evt.message) {
    for (const block of asBlocks(evt.message.content)) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        yield {
          type: 'tool_result',
          id: block.tool_use_id,
          output: toolResultText(block.content),
          isError: block.is_error === true,
        };
      }
    }
    return;
  }

  if (evt.type === 'result') {
    if (evt.usage || evt.total_cost_usd !== undefined) {
      yield {
        type: 'usage',
        inputTokens: evt.usage?.input_tokens,
        outputTokens: evt.usage?.output_tokens,
        costUsd: evt.total_cost_usd,
      };
    }
    if (evt.is_error) {
      yield {
        type: 'error',
        message: evt.result?.trim() || `agent run failed (${evt.subtype ?? 'error'})`,
      };
      return;
    }
    yield { type: 'done', sessionId: evt.session_id };
  }
}

function asBlocks(content: ContentBlock | ContentBlock[] | undefined): ContentBlock[] {
  if (!content) return [];
  return Array.isArray(content) ? content : [content];
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof (part as ContentBlock).text === 'string') {
          return (part as ContentBlock).text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object') {
    return JSON.stringify(content);
  }
  return '';
}
