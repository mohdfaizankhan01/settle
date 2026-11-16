// Reading an uploaded photo's bytes with a hard cap, so an oversized upload is refused before it
// is buffered (the same idea as lib/settle/webhook.ts readBodyLimited, for bytes).

/** The body's bytes, or undefined when it is larger than `maxBytes`. */
export async function readBytesLimited(request: Request, maxBytes: number): Promise<Uint8Array | undefined> {
  if (Number(request.headers.get('content-length')) > maxBytes) return undefined;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
