import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { createVisionProvider } from '../recognize.js';
import { createVisionModelClient } from '../visionModelClient.js';

// 08 §G step 19: "call recognize() against 2-3 real photos through the
// actual hosted provider and eyeball results — the one sprint task that
// costs real API money, so do it deliberately rather than in a loop or in
// CI." This script is that deliberate, one-off run: it is NOT part of the
// test suite, `npm test`, or CI, and does nothing unless invoked by hand
// with real photo paths.
//
// Usage (from the repo root, after `npm run build -w @tally/vision`):
//   VISION_PROVIDER_API_KEY=sk-... node packages/vision/dist/scripts/manual-recognize.js photo1.jpg photo2.jpg

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function contentTypeFor(path: string): string {
  const type = CONTENT_TYPES[extname(path).toLowerCase()];
  if (!type) {
    throw new Error(`Unrecognized photo extension for "${path}" — expected one of ${Object.keys(CONTENT_TYPES).join(', ')}`);
  }
  return type;
}

async function main(): Promise<void> {
  const photoPaths = process.argv.slice(2);
  if (photoPaths.length === 0) {
    console.error('Usage: manual-recognize.js <photo-path> [photo-path...]');
    process.exit(1);
  }

  const apiKey = process.env.VISION_PROVIDER_API_KEY;
  if (!apiKey) {
    console.error('VISION_PROVIDER_API_KEY is not set — this is the real-money manual check, so it refuses to run without one.');
    process.exit(1);
  }

  const provider = createVisionProvider({
    fetchByKey: async (path: string) => ({
      bytes: await readFile(path),
      contentType: contentTypeFor(path),
    }),
    visionClient: createVisionModelClient({
      apiKey,
      baseUrl: process.env.VISION_PROVIDER_BASE_URL,
      model: process.env.VISION_PROVIDER_MODEL,
    }),
  });

  for (const photoPath of photoPaths) {
    console.log(`\n=== ${photoPath} ===`);
    try {
      const candidate = await provider.recognize(photoPath);
      console.log(JSON.stringify(candidate, null, 2));
    } catch (error) {
      console.error('Failed:', error);
    }
  }
}

main();
