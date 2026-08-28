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

const QUERYABLE_TABLES = ['channel_meta', 'basicstat_day', 'basicstat_month', 'freqpeaks_day', 'freqpeaks_month'];
const FILTER_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'ilike', 'like'];

async function queryTable({ table, filters, order_by, order_dir, limit }) {
  if (!QUERYABLE_TABLES.includes(table)) {
    return { error: `조회할 수 없는 테이블입니다: ${table}. 가능한 테이블: ${QUERYABLE_TABLES.join(', ')}` };
  }
  const params = new URLSearchParams();
  params.set('select', '*');
  if (Array.isArray(filters)) {
    for (const f of filters) {
      if (!f || !f.column || !FILTER_OPS.includes(f.op) || f.value === undefined) continue;
      params.append(f.column, `${f.op}.${f.value}`);
    }
  }
  if (order_by) {
    params.set('order', `${order_by}.${order_dir === 'asc' ? 'asc' : 'desc'}`);
  }
  params.set('limit', String(Math.min(Number(limit) || 20, 500)));
  const rows = await supabaseSelect(table, params.toString());
  return { table, row_count: rows.length, rows };
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
      name: 'query_table',
      description:
        `계측 데이터 테이블(${QUERYABLE_TABLES.join(', ')}) 중 하나를 조건에 맞게 조회한다. ` +
        '채널 목록 조회, 특정 채널 검색, 특정 기간·조건의 통계 조회 등 수치·목록 관련 질문 전반에 사용한다. ' +
        'channel_meta: channelid, channelname, physicalunit, direction. ' +
        'basicstat_day/month: channelid, stat_date 또는 stat_month, samplecount, valuemin, valuemax, valueavg, stdv_avg, rms_avg. ' +
        'freqpeaks_day/month: channelid, stat_date 또는 stat_month, peak_count, peakfreq_avg, peakfreq_min, peakfreq_max, peakmagnitude_avg.',
      parameters: {
        type: 'object',
        properties: {
          table: { type: 'string', enum: QUERYABLE_TABLES },
          filters: {
            type: 'array',
            description:
              '조건 목록 (전체 조회 시 생략 가능). 예: [{"column":"channelname","op":"ilike","value":"*ACC*"}]',
            items: {
              type: 'object',
              properties: {
                column: { type: 'string' },
                op: { type: 'string', enum: FILTER_OPS },
                value: { type: 'string' },
              },
              required: ['column', 'op', 'value'],
            },
          },
          order_by: { type: 'string', description: '정렬 기준 컬럼명 (선택)' },
          order_dir: { type: 'string', enum: ['asc', 'desc'] },
          limit: { type: 'integer', description: '반환할 최대 행 수, 기본 20, 최대 500' },
        },
        required: ['table'],
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
          '너는 인천공항 활주로/구조물 계측 데이터를 설명하는 AI 에이전트다. 채널 목록·수치·조건 조회는 query_table 툴로, 기준/원리 질문은 search_docs 툴로 답한다. ' +
          'basicstat_day/month, freqpeaks_day/month에는 channelname 컬럼이 없다 — 채널명으로 특정 채널의 수치를 물으면 먼저 query_table(channel_meta, channelname ilike)로 channelid를 찾고, 그 channelid로 다시 query_table을 호출해 통계를 조회한다. ' +
          'query_table의 filters는 필요할 때만 채우고, 전체 목록을 물으면 filters 없이 호출한다. 필요하면 여러 번 툴을 호출해도 된다. 한국어로 간결하게 답한다.',
      },
      { role: 'user', content: question },
    ];

    const MAX_TOOL_ROUNDS = 5;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const reply = await callOpenAI(messages);
      messages.push(reply);

      if (!reply.tool_calls) {
        res.status(200).json({ answer: reply.content });
        return;
      }

      for (const call of reply.tool_calls) {
        const args = JSON.parse(call.function.arguments);
        let result;
        if (call.function.name === 'query_table') {
          result = await queryTable(args);
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
    }

    res.status(200).json({ answer: '툴 호출 횟수가 많아 답변을 완성하지 못했습니다. 질문을 더 구체적으로 나눠 물어봐 주세요.' });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
};
