import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaller, buildCallBody, missingConfig, CALL_ENV, E164 } from '../server/voice-call.js';

const ENV = {
  SARVAM_VOICE_API_KEY: 'k', SARVAM_VOICE_ORG_ID: 'org1', SARVAM_VOICE_WORKSPACE_ID: 'ws1',
  SARVAM_VOICE_APP_ID: 'app1', SARVAM_VOICE_APP_VERSION: '3', SARVAM_VOICE_CONNECTION_ID: 'conn1', SARVAM_VOICE_AGENT_NUMBER: '+914000000000',
};

test('missingConfig names what is absent and never values', () => {
  assert.deepEqual(missingConfig({}), [...CALL_ENV]);
  assert.deepEqual(missingConfig(ENV), []);
  assert.deepEqual(missingConfig({ ...ENV, SARVAM_VOICE_APP_ID: '  ' }), ['SARVAM_VOICE_APP_ID']);
});

test('buildCallBody matches the documented outbound schema', () => {
  const b = buildCallBody(ENV, { phone: '+919999999999', reminderText: 'take medicine', userName: 'Ryyan' });
  assert.equal(b.app_config.app_id, 'app1');
  assert.equal(b.app_config.app_version, 3);
  assert.deepEqual(b.app_config.connection_config, { connection_id: 'conn1', agent_phone_number: '+914000000000' });
  assert.deepEqual(b.app_config.agent_variables, { user_name: 'Ryyan', reminder_text: 'take medicine' });
  assert.equal(b.app_config.app_overrides.initial_language_name, 'Malayalam');
  assert.equal(b.user_config.user_phone_number, '+919999999999');
});

test('phone numbers must be E.164', () => {
  assert.ok(E164.test('+919446709197'));
  assert.ok(!E164.test('9446709197'));
  assert.ok(!E164.test('+0123'));
});

test('call posts to the right URL with the workspace key and returns the attempt id', async () => {
  let seen;
  const fetchImpl = async (url, opts) => { seen = { url, opts }; return { ok: true, status: 200, json: async () => ({ attempt_id: 'att-1' }) }; };
  const r = await createCaller({ env: ENV, fetchImpl }).call({ phone: '+919999999999', reminderText: 'call Amma', userName: 'R' });
  assert.deepEqual(r, { ok: true, attemptId: 'att-1' });
  assert.equal(seen.url, 'https://apps.sarvam.ai/api/outbounds/v1/orgs/org1/workspaces/ws1/outbounds');
  assert.equal(seen.opts.headers['X-API-Key'], 'k');
  assert.equal(JSON.parse(seen.opts.body).user_config.user_phone_number, '+919999999999');
});

test('not configured, bad phone, empty reminder and upstream failure are reported without calling out', async () => {
  let called = 0;
  const fetchImpl = async () => { called += 1; return { ok: false, status: 422, json: async () => ({}) }; };
  assert.equal((await createCaller({ env: {}, fetchImpl }).call({ phone: '+919999999999', reminderText: 'x' })).error, 'not_configured');
  assert.equal((await createCaller({ env: ENV, fetchImpl }).call({ phone: '12345', reminderText: 'x' })).error, 'bad_phone');
  assert.equal((await createCaller({ env: ENV, fetchImpl }).call({ phone: '+919999999999', reminderText: '  ' })).error, 'empty_reminder');
  assert.equal(called, 0);
  const up = await createCaller({ env: ENV, fetchImpl }).call({ phone: '+919999999999', reminderText: 'x' });
  assert.equal(up.error, 'upstream_error');
  assert.equal(up.status, 422);
});
