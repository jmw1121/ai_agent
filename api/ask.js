const SUPABASE_URL = 'https://rxohwqbxnehnqbjfuhgr.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_exJWio9jlBXFaXMHW6Eyow_Nqetd9_Q';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CHAT_MODEL = 'gpt-4o-mini';
const EMBED_MODEL = 'text-embedding-3-small';
const EMBED_DIMENSIONS = 512;

async function supabaseSelect(table, params) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${params}`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase ${table} query failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function getChannelStat({ channel_name, metric, granularity, limit }) {
  const channels = await supabaseSelect(
    'channel_meta',
    `channelname=ilike.*${encodeURIComponent(channel_name)}*&select=channelid,channelname,physicalunit&limit=1`
  );
  if (!channels.length) {
    return { error: `채널 "${channel_name}"을(를) 찾지 못했습니다.` };
  }
  const channel = channels[0];
  const table = `${metric}_${granularity}`;
  const orderCol = granularity === 'day' ? 'stat_date' : 'stat_month';
  const rows = await supabaseSelect(
    table,
    `channelid=eq.${channel.channelid}&select=*&order=${orderCol}.desc&limit=${limit || 6}`
  );
  return { channel, rows: rows.reverse() };
}

function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function embedText(text) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: text, dimensions: EMBED_DIMENSIONS }),
  });
  const json = await res.json();
  if (!json.data) throw new Error('embedding failed: ' + JSON.stringify(json));
  return json.data[0].embedding;
}

async function searchDocs({ query }) {
  const queryVec = await embedText(query);
  const chunks = await supabaseSelect('doc_chunks', 'select=id,source,source_url,content,embedding&limit=500');
  const scored = chunks
    .map((c) => ({
      ...c,
      score: cosineSimilarity(queryVec, JSON.parse(c.embedding)),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  return scored.map((c) => ({ source: c.source, content: c.content, score: c.score.toFixed(3) }));
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_channel_stat',
      description:
        '센서 채널의 일별 또는 월별 계측 통계(진동 가속도 basicstat, 진동 주파수 freqpeaks)를 조회한다. 정확한 수치가 필요한 질문에 사용한다.',
      parameters: {
        type: 'object',
        properties: {
          channel_name: { type: 'string', description: '채널명 일부 (예: ACC-04-X, 유도선교량)' },
          metric: { type: 'string', enum: ['basicstat', 'freqpeaks'] },
          granularity: { type: 'string', enum: ['day', 'month'] },
          limit: { type: 'integer', description: '조회할 최근 기간 수, 기본 6' },
        },
        required: ['channel_name', 'metric', 'granularity'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_docs',
      description: '공항 시설 설계 기준·매뉴얼 등 외부 표준 문서에서 관련 내용을 검색한다. 원리, 기준, 정의를 묻는 질문에 사용한다.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '검색할 질의 문장' },
        },
        required: ['query'],
      },
    },
  },
];

async function callOpenAI(messages) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: CHAT_MODEL, messages, tools: TOOLS }),
  });
  const json = await res.json();
  if (!json.choices) throw new Error('chat completion failed: ' + JSON.stringify(json));
  return json.choices[0].message;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST만 지원합니다.' });
    return;
  }
  const { question } = req.body || {};
  if (!question) {
    res.status(400).json({ error: 'question이 필요합니다.' });
    return;
  }

  try {
    const messages = [
      {
        role: 'system',
        content:
          '너는 인천공항 활주로/구조물 계측 데이터를 설명하는 AI 에이전트다. 수치 질문은 get_channel_stat 툴로, 기준/원리 질문은 search_docs 툴로 답한다. 한국어로 간결하게 답한다.',
      },
      { role: 'user', content: question },
    ];

    const first = await callOpenAI(messages);
    messages.push(first);

    if (first.tool_calls) {
      for (const call of first.tool_calls) {
        const args = JSON.parse(call.function.arguments);
        let result;
        if (call.function.name === 'get_channel_stat') {
          result = await getChannelStat(args);
        } else if (call.function.name === 'search_docs') {
          result = await searchDocs(args);
        } else {
          result = { error: 'unknown tool' };
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
      const final = await callOpenAI(messages);
      res.status(200).json({ answer: final.content });
      return;
    }

    res.status(200).json({ answer: first.content });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
};
