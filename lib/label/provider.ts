// The one provider call the label-photo reader makes: Groq's OpenAI-compatible chat completions
// with an image, plain fetch, no SDK. Mocked in tests; no test calls the network. The photo is
// sent once and never stored or logged here. Swap this file to change provider.
// Docs: https://console.groq.com/docs/vision (checked 2026-11-16: qwen/qwen3.8-27b takes images).

export type VisionRequest = { system: string; user: string; /** A data: URL holding the photo. */ imageUrl: string; schema: object };
export type VisionReply = { model: string; content: string; usage: { input: number; output: number } };
export type AskVision = (request: VisionRequest, model: string) => Promise<VisionReply>;

/** The reader didn't run, and that isn't an error: no key, the provider's own limit. */
export class VisionSkip extends Error {
  name = 'VisionSkip';
}

export const VISION_TIMEOUT_MS = 20_000;
const URL = 'https://api.groq.com/openai/v1/chat/completions';

export const askGroqVision: AskVision = async (request, model) => {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new VisionSkip('no AI reader key is set');
  const res = await fetch(URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    // One attempt, no retries.
    signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: 'system', content: request.system },
        {
          role: 'user',
          content: [
            { type: 'text', text: request.user },
            { type: 'image_url', image_url: { url: request.imageUrl } },
          ],
        },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'label_reading', strict: false, schema: request.schema } },
      max_completion_tokens: 600,
    }),
  });
  if (res.status === 429) throw new VisionSkip("Groq's rate limit was reached");
  // Only the error code is kept: Groq's error body can echo what it read (an address).
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
  if (choice?.finish_reason !== 'stop') throw new Error(`the model stopped with ${choice?.finish_reason ?? 'no reason'}`);
  if (typeof choice.message?.content !== 'string') throw new Error('no answer text');
  return { model: body.model ?? model, content: choice.message.content, usage: { input: body.usage?.prompt_tokens ?? 0, output: body.usage?.completion_tokens ?? 0 } };
};
