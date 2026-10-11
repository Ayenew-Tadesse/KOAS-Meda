const test = require('node:test');
const assert = require('node:assert');

process.env.MOCK = '1';
const server = require('../server');

test('API endpoints', async (t) => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());

  const sb = await (await fetch(`${base}/api/scoreboard?dates=20261001-20261031`)).json();
  assert.strictEqual(sb.events.length, 3);
  assert.ok(sb.updatedAt);

  assert.strictEqual((await fetch(`${base}/api/scoreboard`)).status, 400);
  assert.strictEqual((await fetch(`${base}/api/scoreboard?dates=bad`)).status, 400);
  assert.strictEqual((await fetch(`${base}/`)).status, 200);
  assert.strictEqual((await fetch(`${base}/core.js`)).status, 200);
  assert.notStrictEqual((await fetch(`${base}/..%2fserver.js`)).status, 200);
});
