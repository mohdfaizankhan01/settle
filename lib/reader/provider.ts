// The one provider call the AI reader makes: Groq's OpenAI-compatible chat completions API,
// with plain fetch (no SDK dependency) and strict JSON-schema output. Swap this file to change
// provider. Mocked in tests; no test calls the network.
// Docs: https://console.groq.com/docs/structured-outputs (checked 2026-11-10).

export type ReaderReply = { model: string; content: string; usage: { input: number; output: number } };

/** Takes the built request and a model ID; returns the raw JSON text the model wrote. */
export type AskReader = (request: { system: string; user: string; schema: object }, model: string) => Promise<ReaderReply>;

/** The reader didn't run, and that isn't an error: no key, a rate cap, the provider's own limit. */
export class ReaderSkip extends Error {
  name = 'ReaderSkip';
}

export const READER_TIMEOUT_MS = 10_000;
const URL = 'https://api.groq.com/openai/v1/chat/completions';

export const askGroq: AskReader = async (request, model) => {
  // Read the key on each call, inside readDeal's try: a missing key means skipped, not a crash.
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new ReaderSkip('no AI reader key is set');
  const res = await fetch(URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    // One attempt, no retries.
    signal: AbortSignal.timeout(READER_TIMEOUT_MS),
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'deal_reading', strict: process.env.SETTLE_READER_STRICT === 'true', schema: request.schema } },
      // gpt-oss models reason first; low keeps latency and tokens down (eval decides).
      ...(model.startsWith('openai/gpt-oss') ? { reasoning_effort: process.env.SETTLE_READER_EFFORT || 'low' } : {}),
      max_completion_tokens: 2000,
    }),
  });
  if (res.status === 429) throw new ReaderSkip("Groq's rate limit was reached");
  // Only the error code is kept: Groq's error body can echo the generated answer (chat text).
  if (!res.ok) {
    const code = await res.json().then((b: { error?: { code?: unknown } }) => (typeof b?.error?.code === 'string' ? b.error.code.slice(0, 40) : ''), () => '');
    throw new Error(`Groq answered HTTP ${res.status}${code ? ` (${code})` : ''}`);
  }
  const body = (await res.json()) as {
    model?: string;
    choices?: { finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = body.choices?.[0];
  if (choice?.message?.refusal) throw new Error('the model refused');
  // "length" (cut off), "content_filter" or anything but a normal stop is a failed run.
  if (choice?.finish_reason !== 'stop') throw new Error(`the model stopped with ${choice?.finish_reason ?? 'no reason'}`);
  if (typeof choice.message?.content !== 'string') throw new Error('no answer text');
  return {
    model: body.model ?? model,
    content: choice.message.content,
    usage: { input: body.usage?.prompt_tokens ?? 0, output: body.usage?.completion_tokens ?? 0 },
  };
};
