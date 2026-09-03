import type { AgentEvent } from '../types';

/**
 * Kimi Code CLI stream-json translator.
 *
 * The official docs describe the event *kinds* — Assistant text messages,
 * Assistant messages carrying `tool_calls`, Tool result messages, and a
 * "session resume hint" meta message — but not their field-level shapes.
 * This normalizer therefore accepts the plausible variants (OpenAI-style
 * `message.tool_calls`, content-block arrays, plain strings, snake/camel
 * ids). Assumption-based: re-verify against real CLI output when one is
 * available; unknown lines are logged and skipped by the pump.
 */
interface LooseRecord {
  [key: string]: unknown;
}

export function* translateKimiEvent(raw: unknown): Generator<AgentEvent> {
  if (!raw || typeof raw !== 'object') return;
  const obj = raw as LooseRecord;
  const type = typeof obj.type === 'string' ? obj.type : undefined;

  // Session id carrier: explicit meta/system lines only — assistant lines
  // may repeat the id and re-emitting system events per message would just
  // churn the run state.
  const sessionId = pickString(obj, ['session_id', 'sessionId']);
  if (sessionId && type !== undefined && ['meta', 'session', 'system', 'session_start'].includes(type)) {
    yield { type: 'system', sessionId };
  }

  const message = asLoose(obj.message) ?? obj;
  const role = typeof message.role === 'string' ? message.role : undefined;
  const isAssistant =
    type === 'assistant' ||
    (type === 'message' && role === 'assistant') ||
    (type === undefined && role === 'assistant');
  if (isAssistant) {
    const text = flattenText(message.content);
    if (text) yield { type: 'text', delta: text };
    const toolCalls = message.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const [i, call] of toolCalls.entries()) {
        const parsed = normalizeToolCall(call, i);
        if (parsed) yield parsed;
      }
    }
    yield* usageEvents(obj);
    return;
  }

  if (type === 'tool' || role === 'tool' || type === 'tool_result') {
    yield {
      type: 'tool_result',
      id: pickString(message, ['tool_call_id', 'toolCallId', 'call_id'])
        ?? pickString(obj, ['tool_call_id', 'toolCallId', 'call_id'])
        ?? '',
      output: flattenText(message.content ?? obj.content ?? obj.output),
      isError: obj.is_error === true || obj.isError === true || obj.error === true,
    };
    yield* usageEvents(obj);
    return;
  }

  if (type === 'result' || type === 'turn.ended' || type === 'done') {
    yield* usageEvents(obj);
    yield { type: 'done', sessionId: sessionId ?? undefined };
  }
}

function* usageEvents(container: LooseRecord): Generator<AgentEvent> {
  const usage = asLoose(container.usage);
  if (!usage) return;
  const input = pickNumber(usage, ['input_tokens', 'inputTokens', 'prompt_tokens']);
  const output = pickNumber(usage, ['output_tokens', 'outputTokens', 'completion_tokens']);
  if (input !== undefined || output !== undefined) {
    yield { type: 'usage', inputTokens: input, outputTokens: output };
  }
}

function normalizeToolCall(call: unknown, index: number): AgentEvent | undefined {
  if (!call || typeof call !== 'object') return undefined;
  const rec = call as LooseRecord;
  const fn = asLoose(rec.function) ?? asLoose(rec.function_call);
  const name = pickString(rec, ['name']) ?? pickString(fn ?? {}, ['name']) ?? 'tool';
  let input: unknown = {};
  const rawArgs = pickString(rec, ['arguments', 'input']) ?? pickString(fn ?? {}, ['arguments']);
  if (rawArgs) {
    try {
      input = JSON.parse(rawArgs) as unknown;
    } catch {
      input = rawArgs;
    }
  } else if (rec.input !== undefined) {
    input = rec.input;
  }
  return {
    type: 'tool_use',
    id: pickString(rec, ['id']) ?? `toolu-kimi-${index}`,
    name,
    input,
  };
}

function asLoose(value: unknown): LooseRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as LooseRecord)
    : undefined;
}

function pickString(obj: LooseRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function pickNumber(obj: LooseRecord, keys: string[]): number | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

/** String content | block arrays | {text} — whatever the CLI ends up emitting. */
function flattenText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        const rec = asLoose(part);
        if (rec && typeof rec.text === 'string') return rec.text;
        return '';
      })
      .filter(Boolean)
      .join('');
  }
  const rec = asLoose(content);
  if (rec && typeof rec.text === 'string') return rec.text;
  return '';
}
