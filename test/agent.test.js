import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanAction, parseModelJson, createAgent, TOOLS } from '../server/agent.js';

test('cleanAction accepts known tools and coerces numbers', () => {
  assert.deepEqual(cleanAction({ tool: 'remind', args: { text: 'drink water', minutes: '10' } }), { tool: 'remind', args: { text: 'drink water', minutes: 10 } });
  assert.deepEqual(cleanAction({ tool: 'media', args: { command: 'next' } }), { tool: 'media', args: { command: 'next' } });
  assert.deepEqual(cleanAction({ tool: 'tidy_desktop' }), { tool: 'tidy_desktop', args: {} });
});

test('cleanAction rejects unknown tools, bad args and absurd numbers', () => {
  assert.equal(cleanAction({ tool: 'rm_rf', args: {} }), null);
  assert.equal(cleanAction({ tool: 'open_app', args: {} }), null);
  assert.equal(cleanAction({ tool: 'media', args: { command: 'format' } }), null);
  assert.equal(cleanAction({ tool: 'timer', args: { seconds: -5 } }), null);
  assert.equal(cleanAction({ tool: 'timer', args: { seconds: 1e12 } }), null);
  assert.equal(cleanAction(null), null);
});

test('whatsapp keeps optional fields only when present', () => {
  assert.deepEqual(cleanAction({ tool: 'whatsapp', args: { contact: 'Amma' } }), { tool: 'whatsapp', args: { contact: 'Amma' } });
  assert.deepEqual(cleanAction({ tool: 'whatsapp', args: {} }), { tool: 'whatsapp', args: {} });
});

test('parseModelJson handles fences and prose', () => {
  assert.deepEqual(parseModelJson('```json\n{"reply":"hi","actions":[]}\n```'), { reply: 'hi', actions: [] });
  assert.deepEqual(parseModelJson('Sure! {"reply":"ok","actions":[]} done'), { reply: 'ok', actions: [] });
  assert.equal(parseModelJson('no json here'), null);
  assert.equal(parseModelJson(undefined), null);
});

const fakeFetch = (content, ok = true) => async () => ({ ok, status: ok ? 200 : 500, json: async () => ({ choices: [{ message: { content } }] }) });

test('agent returns a validated reply and drops invalid actions', async () => {
  const content = JSON.stringify({ reply: 'ശരി', actions: [{ tool: 'remind', args: { text: 'മരുന്ന്', minutes: 30 } }, { tool: 'hack', args: {} }] });
  const agent = createAgent({ apiKey: 'k', fetchImpl: fakeFetch(content) });
  const r = await agent.run({ text: 'remind me' });
  assert.equal(r.ok, true);
  assert.equal(r.reply, 'ശരി');
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].tool, 'remind');
});

test('agent without a key says so and acts on nothing', async () => {
  const r = await createAgent({}).run({ text: 'hello' });
  assert.equal(r.offline, true);
  assert.deepEqual(r.actions, []);
});

test('agent survives a failing upstream and empty input', async () => {
  const bad = await createAgent({ apiKey: 'k', fetchImpl: fakeFetch('x', false) }).run({ text: 'hi' });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.actions, []);
  const empty = await createAgent({ apiKey: 'k', fetchImpl: fakeFetch('{}') }).run({ text: '   ' });
  assert.equal(empty.ok, false);
});

test('the tool list is the only surface the model can reach', () => {
  assert.deepEqual(Object.keys(TOOLS).sort(), ['appearance', 'battery_status', 'briefing', 'call_me', 'find_files', 'media', 'open_app', 'quit_app', 'remember', 'remind', 'set_brightness', 'set_volume', 'tidy_desktop', 'timer', 'translate_clipboard', 'whatsapp', 'youtube_summary']);
});

test('percent tools allow 0 and reject out-of-range values', () => {
  assert.deepEqual(cleanAction({ tool: 'set_brightness', args: { percent: 0 } }), { tool: 'set_brightness', args: { percent: 0 } });
  assert.deepEqual(cleanAction({ tool: 'set_volume', args: { percent: '35' } }), { tool: 'set_volume', args: { percent: 35 } });
  assert.equal(cleanAction({ tool: 'set_brightness', args: { percent: 150 } }), null);
  assert.equal(cleanAction({ tool: 'set_volume', args: { percent: -1 } }), null);
  assert.deepEqual(cleanAction({ tool: 'appearance', args: { mode: 'dark' } }), { tool: 'appearance', args: { mode: 'dark' } });
  assert.equal(cleanAction({ tool: 'appearance', args: { mode: 'purple' } }), null);
});
