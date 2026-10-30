// Sentence embeddings for Settle Link's model B: MiniLM-L6 (quantized ONNX, 384 dimensions) run
// in-process with transformers.js. The model files are fetched once at build time into ./models
// (`npm run model:fetch`); at runtime nothing is downloaded, and missing files make the check fail
// closed.

import { join } from 'node:path';
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import type { SparseVector } from './features';

export const EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const EMBED_DIMS = 384;
export const MODELS_DIR = join(process.cwd(), 'models');

let extractor: Promise<FeatureExtractionPipeline> | undefined;

function load(allowDownload: boolean): Promise<FeatureExtractionPipeline> {
  env.cacheDir = MODELS_DIR;
  env.localModelPath = MODELS_DIR;
  env.allowLocalModels = true;
  env.allowRemoteModels = allowDownload;
  return pipeline('feature-extraction', EMBED_MODEL, { dtype: 'q8' }) as Promise<FeatureExtractionPipeline>;
}

/** Downloads the model files into ./models. Build time only. */
export async function fetchEmbedModel() {
  await load(true);
}

const dense = (v: number[]): SparseVector => ({ idx: Int32Array.from(v.keys()), val: Float32Array.from(v) });

/** Mean-pooled, normalised embeddings, one per text. */
export async function embedTexts(texts: string[]): Promise<SparseVector[]> {
  if (texts.length === 0) return [];
  extractor ??= load(false).catch((error) => {
    extractor = undefined;
    throw error;
  });
  const run = await extractor;
  const vectors: SparseVector[] = [];
  // Fixed-size batches keep memory flat however many pieces a chat has.
  for (let i = 0; i < texts.length; i += 32) {
    const out = await run(texts.slice(i, i + 32), { pooling: 'mean', normalize: true });
    vectors.push(...(out.tolist() as number[][]).map(dense));
  }
  return vectors;
}
