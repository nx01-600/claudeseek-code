// Protocol translation: Anthropic Messages API (what Claude Code speaks)
// <-> DeepSeek's API, compatible with OpenAI's chat/completions format.
//
// Covers: text (streaming and non-streaming), tools (tool_use / tool_result),
// images, system prompt, DeepSeek reasoning exposed as Anthropic "thinking"
// blocks, stop_reason, and usage (including cache hits).
//
// Images: only translated if the chosen model understands them ("vision"
// field in config.json). deepseek-flash does analyze them, and accepts them
// both in a user message and inside a tool_result — the latter is what lets
// a screenshot actually reach the model. With a non-vision model, every
// image is replaced with a text notice.
//
// Not covered (documented in the README):
// - Anthropic "server-side" tools (web_search, code_execution): Anthropic
//   executes them, not the client, so DeepSeek can't use them.
// - cache_control: DeepSeek only caches server-side.

const IMAGE_PLACEHOLDER = '[image omitted: the chosen DeepSeek model doesn\'t analyze images. Use deepseek-flash, which does see them.]';

// Anthropic requires a signature on every "thinking" block. Only Anthropic
// verifies it, and in DeepSeek mode no request ever reaches Anthropic, so a
// fixed recognizable value is enough.
const GATEWAY_SIGNATURE = 'deepseek-gateway';

function flattenToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text);
    else if (block.type === 'image') parts.push(IMAGE_PLACEHOLDER);
    else if (block.type === 'tool_result') {
      const inner = flattenToText(block.content ?? '');
      parts.push(block.is_error ? `ERROR: ${inner}` : inner);
    }
  }
  return parts.join('\n');
}

// Anthropic's "image" block -> OpenAI's "image_url" part, the format
// DeepSeek accepts the same in a user message as in a tool one.
// Returns null if the source isn't translatable.
function imageBlockToPart(block) {
  const src = block.source || {};
  if (src.type === 'base64' && src.data) {
    return { type: 'image_url', image_url: { url: `data:${src.media_type || 'image/png'};base64,${src.data}` } };
  }
  if (src.type === 'url' && src.url) {
    return { type: 'image_url', image_url: { url: src.url } };
  }
  return null;
}

// Anthropic content blocks -> OpenAI "content". Without images it returns a
// string (more compatible format); with images, an array of text/image parts
// in the original order, so what each image refers to isn't altered.
function blocksToOpenAIContent(blocks, { vision }) {
  const parts = [];
  let hasImage = false;
  for (const block of blocks || []) {
    if (block.type === 'text') {
      if (block.text) parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'image') {
      const part = vision ? imageBlockToPart(block) : null;
      if (part) { parts.push(part); hasImage = true; }
      else parts.push({ type: 'text', text: IMAGE_PLACEHOLDER });
    }
  }
  if (!hasImage) return parts.map((p) => p.text).join('\n');
  return parts;
}

// Content of a tool_result. May carry text, images (screenshots), or both.
// OpenAI's format has no "is_error", so the error is still marked with a
// text prefix.
function toolResultContent(block, { vision }) {
  const raw = block.content;
  const blocks = Array.isArray(raw) ? raw : (raw ? [{ type: 'text', text: String(raw) }] : []);
  let content = blocksToOpenAIContent(blocks, { vision });
  if (!content || (Array.isArray(content) && !content.length)) content = '(no content)';
  if (!block.is_error) return content;
  return Array.isArray(content)
    ? [{ type: 'text', text: 'ERROR:' }, ...content]
    : `ERROR: ${content}`;
}

// Reasoning mode of the chosen model:
//   "on"   -> always reasons
//   "off"  -> never reasons
//   "auto" -> only reasons if Claude Code asks for it in the request
export function shouldThink(body, thinkingMode) {
  if (thinkingMode === 'on') return true;
  if (thinkingMode === 'off') return false;
  return !!body.thinking && body.thinking.type !== 'disabled';
}

// Some OpenAI-compatible providers reject "$schema" inside a function's parameters.
function cleanSchema(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  const { $schema, ...rest } = schema;
  return rest;
}

// Anthropic request -> OpenAI request (to send to DeepSeek).
// "vision" is decided by config.json per model; defaults to true (the
// default model, deepseek-flash, does analyze images). A non-vision model
// fails hard against DeepSeek if it gets an image, so when in doubt it's
// better to let the image through and see the error, rather than silently
// dropping it.
export function anthropicToOpenAIRequest(body, { modelId, thinking, vision = true }) {
  const messages = [];

  if (body.system) {
    const sysText = flattenToText(body.system);
    if (sysText) messages.push({ role: 'system', content: sysText });
  }

  for (const msg of body.messages || []) {
    if (typeof msg.content === 'string') {
      messages.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (!Array.isArray(msg.content)) continue;

    const textParts = [];    // assistant: text to return
    const userBlocks = [];   // user: text and images, in order
    const thinkingParts = [];
    const toolResults = [];
    const toolCalls = [];

    for (const block of msg.content) {
      switch (block.type) {
        case 'text':
          if (msg.role === 'assistant') textParts.push(block.text);
          else userBlocks.push(block);
          break;
        case 'image':
          // Don't exist in an assistant message; in the user's they're
          // interleaved with the text.
          if (msg.role !== 'assistant') userBlocks.push(block);
          break;
        case 'thinking': if (block.thinking) thinkingParts.push(block.thinking); break;
        case 'tool_result':
          toolResults.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: toolResultContent(block, { vision }),
          });
          break;
        case 'tool_use':
          toolCalls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input || {}) } });
          break;
        default: break; // redacted_thinking and others: don't apply to DeepSeek
      }
    }

    if (msg.role === 'assistant') {
      if (!textParts.length && !toolCalls.length) continue;
      const out = { role: 'assistant', content: textParts.join('\n') || (toolCalls.length ? null : '') };
      if (toolCalls.length) out.tool_calls = toolCalls;
      // DeepSeek needs to receive its own reasoning back during a tool cycle
      // in thinking mode.
      if (thinkingParts.length) out.reasoning_content = thinkingParts.join('\n');
      messages.push(out);
    } else {
      // "tool" messages must come immediately after the assistant that
      // requested the tools; the user's text and images follow.
      messages.push(...toolResults);
      const content = blocksToOpenAIContent(userBlocks, { vision });
      if (content && (!Array.isArray(content) || content.length)) messages.push({ role: 'user', content });
    }
  }

  const openai = {
    model: modelId,
    messages,
    max_tokens: body.max_tokens,
    thinking: { type: thinking ? 'enabled' : 'disabled' },
  };
  if (body.temperature != null) openai.temperature = body.temperature;
  if (body.top_p != null) openai.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) {
    openai.stop = body.stop_sequences.slice(0, 4);
  }

  const fnTools = (body.tools || []).filter((t) => t.input_schema);
  if (fnTools.length) {
    openai.tools = fnTools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description || '', parameters: cleanSchema(t.input_schema) },
    }));
    const tc = body.tool_choice;
    if (tc?.type === 'auto') openai.tool_choice = 'auto';
    else if (tc?.type === 'any') openai.tool_choice = 'required';
    else if (tc?.type === 'none') openai.tool_choice = 'none';
    else if (tc?.type === 'tool') openai.tool_choice = { type: 'function', function: { name: tc.name } };
  }
  return openai;
}

function mapFinishReason(openaiFinish) {
  if (openaiFinish === 'length') return 'max_tokens';
  if (openaiFinish === 'tool_calls') return 'tool_use';
  return 'end_turn';
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil((text || '').length / 4));
}

function randomId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

// If the model cut off at max_tokens mid-arguments, the JSON is left
// invalid. "{}" is sent so Claude Code gets a normal tool error instead of
// breaking while parsing.
function safeArgs(args) {
  if (!args) return '{}';
  try { JSON.parse(args); return args; } catch { return '{}'; }
}

// DeepSeek usage -> Anthropic usage. In Anthropic, input_tokens does NOT
// include what was read from cache; that goes in cache_read_input_tokens.
export function mapUsage(usage, { fallbackInput = 1, fallbackOutput = 1 } = {}) {
  const promptTotal = usage?.prompt_tokens ?? fallbackInput;
  const cached = usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    anthropic: {
      input_tokens: Math.max(0, promptTotal - cached),
      cache_read_input_tokens: cached,
      output_tokens: usage?.completion_tokens ?? fallbackOutput,
    },
    promptTotal,
    cached,
    output: usage?.completion_tokens ?? fallbackOutput,
    reasoning: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
  };
}

// Full DeepSeek response (non-streaming) -> Anthropic response.
export function openAIResponseToAnthropic(openaiJson, { originalModel, promptCharsEstimate = 0 }) {
  const choice = (openaiJson.choices || [])[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.reasoning_content) {
    content.push({ type: 'thinking', thinking: msg.reasoning_content, signature: GATEWAY_SIGNATURE });
  }
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const tc of msg.tool_calls || []) {
    content.push({
      type: 'tool_use',
      id: tc.id || randomId('toolu'),
      name: tc.function.name,
      input: JSON.parse(safeArgs(tc.function.arguments)),
    });
  }
  const usage = mapUsage(openaiJson.usage, {
    fallbackInput: Math.ceil(promptCharsEstimate / 4) || 1,
    fallbackOutput: estimateTokens(msg.content),
  });
  return {
    anthropic: {
      id: randomId('msg'),
      type: 'message',
      role: 'assistant',
      model: originalModel,
      content,
      stop_reason: mapFinishReason(choice.finish_reason),
      stop_sequence: null,
      usage: usage.anthropic,
    },
    usage,
  };
}

// Stateful translator for streaming. Text and reasoning are relayed live;
// tools are accumulated and emitted complete at the end, because OpenAI can
// interleave the arguments of several parallel calls and Anthropic requires
// sequential blocks (start, deltas, stop).
export class AnthropicStreamTranslator {
  constructor({ originalModel, promptCharsEstimate }) {
    this.originalModel = originalModel;
    this.messageId = randomId('msg');
    this.promptCharsEstimate = promptCharsEstimate || 0;
    this.started = false;
    this.nextIndex = 0;
    this.current = null; // { kind: 'text' | 'thinking', index }
    this.tools = new Map(); // OpenAI index -> { id, name, args }
    this.finishReason = null;
    this.usage = null;
    this.textChars = 0;
  }

  _ev(e) {
    return `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
  }

  _start() {
    this.started = true;
    return this._ev({
      type: 'message_start',
      message: {
        id: this.messageId, type: 'message', role: 'assistant', model: this.originalModel,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: Math.ceil(this.promptCharsEstimate / 4) || 1, output_tokens: 0 },
      },
    });
  }

  _closeCurrent() {
    if (!this.current) return '';
    let out = '';
    if (this.current.kind === 'thinking') {
      out += this._ev({ type: 'content_block_delta', index: this.current.index, delta: { type: 'signature_delta', signature: GATEWAY_SIGNATURE } });
    }
    out += this._ev({ type: 'content_block_stop', index: this.current.index });
    this.current = null;
    return out;
  }

  _ensure(kind) {
    if (this.current?.kind === kind) return '';
    let out = this._closeCurrent();
    const index = this.nextIndex++;
    this.current = { kind, index };
    const block = kind === 'thinking' ? { type: 'thinking', thinking: '', signature: '' } : { type: 'text', text: '' };
    out += this._ev({ type: 'content_block_start', index, content_block: block });
    return out;
  }

  handleChunk(chunk) {
    let out = this.started ? '' : this._start();
    if (chunk.usage) this.usage = chunk.usage;
    const choice = (chunk.choices || [])[0];
    if (!choice) return out;
    if (choice.finish_reason) this.finishReason = choice.finish_reason;
    const delta = choice.delta || {};

    if (delta.reasoning_content) {
      out += this._ensure('thinking');
      out += this._ev({ type: 'content_block_delta', index: this.current.index, delta: { type: 'thinking_delta', thinking: delta.reasoning_content } });
    }
    if (delta.content) {
      this.textChars += delta.content.length;
      out += this._ensure('text');
      out += this._ev({ type: 'content_block_delta', index: this.current.index, delta: { type: 'text_delta', text: delta.content } });
    }
    for (const tc of delta.tool_calls || []) {
      const idx = tc.index ?? 0;
      if (!this.tools.has(idx)) this.tools.set(idx, { id: tc.id, name: '', args: '' });
      const t = this.tools.get(idx);
      if (tc.id) t.id = tc.id;
      if (tc.function?.name) t.name += tc.function.name;
      if (tc.function?.arguments) t.args += tc.function.arguments;
    }
    return out;
  }

  finalize() {
    let out = this.started ? '' : this._start();
    out += this._closeCurrent();
    const ordered = [...this.tools.entries()].sort((a, b) => a[0] - b[0]);
    for (const [, t] of ordered) {
      const index = this.nextIndex++;
      out += this._ev({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: t.id || randomId('toolu'), name: t.name, input: {} } });
      out += this._ev({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: safeArgs(t.args) } });
      out += this._ev({ type: 'content_block_stop', index });
    }
    const usage = mapUsage(this.usage, {
      fallbackInput: Math.ceil(this.promptCharsEstimate / 4) || 1,
      fallbackOutput: Math.max(1, Math.ceil(this.textChars / 4)),
    });
    // If DeepSeek requested tools, stop_reason has to be tool_use even if
    // finish_reason comes back different.
    const stopReason = ordered.length && this.finishReason !== 'length' ? 'tool_use' : mapFinishReason(this.finishReason);
    out += this._ev({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: usage.anthropic });
    out += this._ev({ type: 'message_stop' });
    return { sse: out, usage };
  }
}

export function anthropicErrorEnvelope(type, message) {
  return { type: 'error', error: { type, message } };
}

export function mapHttpStatusToAnthropicErrorType(status) {
  if (status === 401 || status === 403) return 'authentication_error';
  if (status === 402) return 'billing_error';
  if (status === 404) return 'not_found_error';
  if (status === 429) return 'rate_limit_error';
  if (status === 503) return 'overloaded_error';
  if (status >= 500) return 'api_error';
  return 'invalid_request_error';
}
