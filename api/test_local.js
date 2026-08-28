const handler = require('./ask.js');

function mockReqRes(question) {
  const req = { method: 'POST', body: { question } };
  const res = {
    status(code) {
      this._status = code;
      return this;
    },
    json(obj) {
      console.log('STATUS', this._status);
      console.log(JSON.stringify(obj, null, 2));
    },
  };
  return { req, res };
}

async function main() {
  const q = process.argv[2] || 'ACC-04-X 채널 월별 평균 진동값 알려줘';
  const { req, res } = mockReqRes(q);
  await handler(req, res);
}

main();
