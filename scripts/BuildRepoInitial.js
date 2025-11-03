import fetch from 'node-fetch';
import { Pinecone } from '@pinecone-database/pinecone';
import crypto from 'crypto';

(async () => {
  // Initialize Pinecone
  const pc = new Pinecone({ 
    apiKey: '' //key here
  });

  // Target your index and create a namespace
  const index = pc.index('discord-bot-code', 'discord-bot-code-v3tu03c.svc.aped-4627-b74a.pinecone.io');

  const owner = 'jbax1899';
  const repo = 'arete';

  // Fetch repo tree
  const treeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/main?recursive=1`);
  const treeJson = await treeRes.json();
  const files = treeJson.tree.filter(f => f.type === 'blob').map(f => f.path);

  function chunkText(text, maxChars = 1000) {
    const chunks = [];
    let start = 0;
    while (start < text.length) {
      chunks.push(text.slice(start, start + maxChars));
      start += maxChars;
    }
    return chunks;
  }

  function chunkArray(array, batchSize = 96) {
    const result = [];
    for (let i = 0; i < array.length; i += batchSize) {
      result.push(array.slice(i, i + batchSize));
    }
    return result;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  for (const filePath of files) {
    const contentRes = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/main/${filePath}`);
    const content = await contentRes.text();
    const chunks = chunkText(content, 1000);
  
    const records = chunks
    .map((chunk, i) => ({
      _id: crypto.randomUUID(),
      chunk_text: chunk.trim(),
      filePath: filePath.slice(0, 100), // ensure short string
      chunkIndex: i                     // number
    }))
    .filter(r => r.chunk_text.length > 0);
  
    const batches = chunkArray(records, 32); //reduced from 96 to avoid rate limiting

    for (const batch of batches) {
      // verify no record is too big
      for (const r of batch) {
        if (JSON.stringify(r).length > 40000) {
          console.warn('Record too large, skipping:', r._id);
          continue;
        }
      }
      await index.upsertRecords(batch);
      await sleep(1000); // wait 1 second between batches
    }
  }

  console.log('All files processed and upserted with Pinecone embeddings.');
})();