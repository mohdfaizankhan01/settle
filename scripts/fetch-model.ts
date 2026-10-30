// npm run model:fetch — downloads the MiniLM model files (about 24 MB) into ./models, once.
// Runs in `npm run build`, so the server never downloads at runtime. Safe to repeat.

import { EMBED_MODEL, fetchEmbedModel, MODELS_DIR } from '../lib/model/embed';

fetchEmbedModel()
  .then(() => console.log(`${EMBED_MODEL} ready in ${MODELS_DIR}`))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
