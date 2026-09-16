// Traducción de protocolo: Anthropic Messages API (lo que habla Claude Code)
// <-> API de DeepSeek, compatible con el formato chat/completions de OpenAI.
//
// Cubre: texto (streaming y no streaming), herramientas (tool_use /
// tool_result), imágenes, system prompt, razonamiento de DeepSeek expuesto
// como bloques "thinking" de Anthropic, stop_reason y usage (incluido cache
// hit).
//
// Imágenes: se traducen solo si el modelo elegido las entiende (campo
// "vision" en config.json). deepseek-flash sí las analiza, y las acepta tanto
// en un mensaje del usuario como dentro de un tool_result — esto último es lo
// que permite que una captura de pantalla llegue de verdad al modelo. Con un
// modelo sin visión cada imagen se reemplaza por un aviso de texto.
//
// No cubre (documentado en el README):
// - Herramientas "de servidor" de Anthropic (web_search, code_execution):
//   las ejecuta Anthropic, no el cliente, así que DeepSeek no puede usarlas.
// - cache_control: DeepSeek cachea solo del lado del servidor.

const IMAGE_PLACEHOLDER = '[imagen omitida: el modelo DeepSeek elegido no analiza imágenes. Usá deepseek-flash, que sí las ve.]';

// Anthropic exige una firma en cada bloque "thinking". Solo Anthropic la
// verifica, y en modo DeepSeek ninguna petición llega a Anthropic, así que
// basta con un valor fijo reconocible.
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

// Bloque "image" de Anthropic -> parte "image_url" de OpenAI, que es el
// formato que DeepSeek acepta igual en un mensaje user que en uno tool.
// Devuelve null si la fuente no es traducible.
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

// Bloques de contenido de Anthropic -> "content" de OpenAI. Sin imágenes
// devuelve un string (formato más compatible); con imágenes, un array de
// partes texto/imagen en el orden original, para no alterar a qué se refiere
// cada imagen.
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

// Contenido de un tool_result. Puede traer texto, imágenes (capturas de
// pantalla) o ambos. El formato de OpenAI no tiene "is_error", así que el
// error se sigue marcando con un prefijo de texto.
function toolResultContent(block, { vision }) {
  const raw = block.content;
  const blocks = Array.isArray(raw) ? raw : (raw ? [{ type: 'text', text: String(raw) }] : []);
  let content = blocksToOpenAIContent(blocks, { vision });
  if (!content || (Array.isArray(content) && !content.length)) content = '(sin contenido)';
  if (!block.is_error) return content;
  return Array.isArray(content)
    ? [{ type: 'text', text: 'ERROR:' }, ...content]
    : `ERROR: ${content}`;
}

// Modo de razonamiento del modelo elegido:
//   "on"   -> siempre razona
//   "off"  -> nunca razona
//   "auto" -> razona solo si Claude Code lo pide en la petición
export function shouldThink(body, thinkingMode) {
  if (thinkingMode === 'on') return true;
  if (thinkingMode === 'off') return false;
  return !!body.thinking && body.thinking.type !== 'disabled';
}

// Algunos proveedores OpenAI-compatibles rechazan "$schema" dentro de los
// parámetros de una función.
function cleanSchema(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  const { $schema, ...rest } = schema;
  return rest;
}

// Anthropic request -> OpenAI request (para mandar a DeepSeek).
// "vision" lo decide config.json por modelo; por defecto true (el modelo por
// defecto, deepseek-flash, sí analiza imágenes). Un modelo sin visión falla
// fuerte contra DeepSeek si le llega una imagen, así que ante la duda conviene
// que la imagen viaje y el error se vea, en vez de descartarla en silencio.
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

    const textParts = [];    // assistant: texto a devolver
    const userBlocks = [];   // user: texto e imágenes, en orden
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
          // En un mensaje del assistant no existen; en el del usuario van
          // intercaladas con el texto.
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
        default: break; // redacted_thinking y otros: no aplican a DeepSeek
      }
    }

    if (msg.role === 'assistant') {
      if (!textParts.length && !toolCalls.length) continue;
      const out = { role: 'assistant', content: textParts.join('\n') || (toolCalls.length ? null : '') };
      if (toolCalls.length) out.tool_calls = toolCalls;
      // DeepSeek necesita recibir de vuelta su propio razonamiento durante un
      // ciclo de herramientas en modo thinking.
      if (thinkingParts.length) out.reasoning_content = thinkingParts.join('\n');
      messages.push(out);
    } else {
      // Los mensajes "tool" deben ir inmediatamente después del assistant que
      // pidió las herramientas; el texto y las imágenes del usuario van detrás.
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

// Si el modelo cortó por max_tokens a mitad de los argumentos, el JSON queda
// inválido. Se manda "{}" para que Claude Code reciba un error de herramienta
// normal en vez de romperse al parsear.
function safeArgs(args) {
  if (!args) return '{}';
  try { JSON.parse(args); return args; } catch { return '{}'; }
}

// usage de DeepSeek -> usage de Anthropic. En Anthropic input_tokens NO
// incluye lo leído de cache; eso va en cache_read_input_tokens.
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

// Respuesta completa de DeepSeek (no streaming) -> respuesta de Anthropic.
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

// Traductor con estado para streaming. El texto y el razonamiento se
// retransmiten en vivo; las herramientas se acumulan y se emiten completas al
// final, porque OpenAI puede intercalar los argumentos de varias llamadas en
// paralelo y Anthropic exige bloques secuenciales (start, deltas, stop).
export class AnthropicStreamTranslator {
  constructor({ originalModel, promptCharsEstimate }) {
    this.originalModel = originalModel;
    this.messageId = randomId('msg');
    this.promptCharsEstimate = promptCharsEstimate || 0;
    this.started = false;
    this.nextIndex = 0;
    this.current = null; // { kind: 'text' | 'thinking', index }
    this.tools = new Map(); // índice OpenAI -> { id, name, args }
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
    // Si DeepSeek pidió herramientas, el stop_reason tiene que ser tool_use
    // aunque el finish_reason venga distinto.
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
