const SUPABASE_URL = 'https://rxohwqbxnehnqbjfuhgr.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_exJWio9jlBXFaXMHW6Eyow_Nqetd9_Q';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EMBED_MODEL = 'text-embedding-3-small';
const EMBED_DIMENSIONS = 512;
const CHUNK_TARGET = 900;
const CHUNK_OVERLAP = 150;
const MAX_PDF_BYTES = 8 * 1024 * 1024; // 8MB
const EMBED_BATCH_SIZE = 20;

module.exports.config = { api: { bodyParser: false } };

function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error(`파일이 너무 큽니다 (최대 ${Math.round(limit / 1024 / 1024)}MB).`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function cleanText(raw) {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

function chunkText(text, targetSize, overlapSize) {
  const paras = text.split('\n').filter(Boolean);
  const chunks = [];
  let buf = '';
  for (const para of paras) {
    if ((buf + '\n' + para).length > targetSize && buf.length > 0) {
      chunks.push(buf);
      const tail = buf.slice(Math.max(0, buf.length - overlapSize));
      buf = tail + '\n' + para;
    } else {
      buf = buf ? buf + '\n' + para : para;
    }
  }
  if (buf.trim()) chunks.push(buf);
  return chunks;
}

async function embedBatch(texts) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts, dimensions: EMBED_DIMENSIONS }),
  });
  const json = await res.json();
  if (!json.data) throw new Error('임베딩 생성 실패: ' + JSON.stringify(json).slice(0, 300));
  return json.data.map((d) => d.embedding);
}

async function insertChunks(rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/doc_chunks`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`저장 실패: ${res.status} ${await res.text()}`);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST만 지원합니다.' });
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  const source = (url.searchParams.get('source') || '이름 없는 문서').slice(0, 200);
  const sourceUrl = url.searchParams.get('source_url') || null;

  try {
    const buf = await readRawBody(req, MAX_PDF_BYTES);
    if (!buf.length) {
      res.status(400).json({ error: '파일이 비어 있습니다.' });
      return;
    }

    const pdfParse = require('pdf-parse');
    const parsed = await pdfParse(buf);
    const cleaned = cleanText(parsed.text);
    if (!cleaned) {
      res.status(400).json({ error: 'PDF에서 텍스트를 추출하지 못했습니다 (스캔본 이미지 PDF일 수 있음).' });
      return;
    }

    const chunks = chunkText(cleaned, CHUNK_TARGET, CHUNK_OVERLAP);
    let insertedCount = 0;
    for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
      const slice = chunks.slice(i, i + EMBED_BATCH_SIZE);
      const vectors = await embedBatch(slice);
      const rows = slice.map((content, j) => ({
        source,
        source_url: sourceUrl,
        chunk_index: i + j,
        content,
        embedding: vectors[j],
      }));
      await insertChunks(rows);
      insertedCount += rows.length;
    }

    res.status(200).json({ source, chunk_count: insertedCount, page_count: parsed.numpages });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
};
