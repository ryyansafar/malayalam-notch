import test from 'node:test';
import assert from 'node:assert/strict';
import { videoIdFromUrl, captionText, playerResponse, createYoutube } from '../server/youtube.js';
import { cleanAction } from '../server/agent.js';

test('videoIdFromUrl reads watch, short and shorts links', () => {
  assert.equal(videoIdFromUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3'), 'dQw4w9WgXcQ');
  assert.equal(videoIdFromUrl('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(videoIdFromUrl('lofi hip hop'), null);
});

test('captionText joins json3 segments', () => {
  assert.equal(captionText({ events: [{ segs: [{ utf8: 'Hello ' }, { utf8: 'world' }] }, { segs: [{ utf8: '\nagain' }] }] }), 'Hello world again');
});

test('playerResponse finds the object even with braces inside strings', () => {
  const html = 'x var ytInitialPlayerResponse = {"videoDetails":{"title":"A {b} c"}}; var y=1;';
  assert.equal(playerResponse(html).videoDetails.title, 'A {b} c');
});

test('summarize: captions used, summary returned, never fetches beyond youtube', async () => {
  const pr = { videoDetails: { title: 'T', shortDescription: 'D' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en', baseUrl: 'https://www.youtube.com/api/timedtext?v=abc' }] } } };
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('/results')) return { ok: true, text: async () => '"videoRenderer":{"videoId":"abcdefghijk"}' };
    if (url.includes('timedtext')) return { ok: true, text: async () => JSON.stringify({ events: [{ segs: [{ utf8: 'a long enough caption sentence for the test' }] }] }) };
    return { ok: true, text: async () => `var ytInitialPlayerResponse = ${JSON.stringify(pr)};` };
  };
  const yt = createYoutube({ fetchImpl, summarize: async (m) => `sum of: ${m.slice(0, 10)}` });
  const out = await yt.summarize('cats');
  assert.equal(out.ok, true);
  assert.equal(out.source, 'captions');
  assert.equal(out.url, 'https://www.youtube.com/watch?v=abcdefghijk');
  assert.ok(calls.every((u) => u.startsWith('https://www.youtube.com/')));
});

test('summarize fails cleanly: no video, no summary', async () => {
  const none = createYoutube({ fetchImpl: async () => ({ ok: true, text: async () => 'nothing here' }), summarize: async () => 'x' });
  assert.equal((await none.summarize('zzz')).ok, false);
  const bad = createYoutube({ fetchImpl: async () => { throw new Error('offline'); }, summarize: async () => 'x' });
  assert.equal((await bad.summarize('zzz')).error, 'unavailable');
});

test('the model may ask for youtube_summary but never for open_url', () => {
  assert.deepEqual(cleanAction({ tool: 'youtube_summary', args: { query: 'lofi' } }), { tool: 'youtube_summary', args: { query: 'lofi' } });
  assert.equal(cleanAction({ tool: 'open_url', args: { url: 'https://evil.example' } }), null);
});

test('analyze: sends only the given text and labels, returns the model summary', async () => {
  const { createAgent } = await import('../server/agent.js');
  let sent = null;
  const fetchImpl = async (_url, init) => { sent = JSON.parse(init.body); return { ok: true, json: async () => ({ choices: [{ message: { content: 'It is a receipt for tea.' } }] }) }; };
  const agent = createAgent({ apiKey: 'k', fetchImpl });
  const out = await agent.analyze({ name: 'bill.png', kind: 'image', text: 'ചായ 20', labels: ['receipt', 'text'] });
  assert.equal(out, 'It is a receipt for tea.');
  assert.match(sent.messages[1].content, /bill\.png/);
  assert.match(sent.messages[1].content, /receipt, text/);
  assert.equal(await createAgent({ fetchImpl }).analyze({ text: 'x' }), '');
  assert.equal(await agent.analyze({ name: 'empty' }), '');
});
