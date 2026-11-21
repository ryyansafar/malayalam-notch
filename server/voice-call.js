// Phone reminders through Sarvam Voice Agents (Instant Outbound API). The server rings the user's
// phone and a Malayalam agent reads one reminder. Everything the call needs comes from .env (names
// only here, values never logged); if anything is missing the route answers "not configured" and the
// notch falls back to speaking the reminder on the Mac. Request shape from Sarvam's docs:
//   POST https://apps.sarvam.ai/api/outbounds/v1/orgs/{org_id}/workspaces/{workspace_id}/outbounds
//   header X-API-Key (workspace key); body { app_config, user_config, webhook_config? }

export const CALL_ENV = Object.freeze([
  'SARVAM_VOICE_API_KEY', 'SARVAM_VOICE_ORG_ID', 'SARVAM_VOICE_WORKSPACE_ID',
  'SARVAM_VOICE_APP_ID', 'SARVAM_VOICE_APP_VERSION', 'SARVAM_VOICE_CONNECTION_ID', 'SARVAM_VOICE_AGENT_NUMBER',
]);

const BASE = 'https://apps.sarvam.ai/api/outbounds/v1';
export const E164 = /^\+[1-9]\d{7,14}$/;

/** Which required settings are missing (names only). */
export function missingConfig(env) {
  return CALL_ENV.filter((k) => !String(env[k] ?? '').trim());
}

/** Build the outbound request body exactly as the API documents it. */
export function buildCallBody(env, { phone, reminderText, userName, language = 'Malayalam' }) {
  return {
    app_config: {
      app_id: String(env.SARVAM_VOICE_APP_ID).trim(),
      app_version: Number.parseInt(env.SARVAM_VOICE_APP_VERSION, 10),
      connection_config: {
        connection_id: String(env.SARVAM_VOICE_CONNECTION_ID).trim(),
        agent_phone_number: String(env.SARVAM_VOICE_AGENT_NUMBER).trim(),
      },
      agent_variables: { user_name: userName, reminder_text: reminderText },
      app_overrides: { initial_language_name: language },
    },
    user_config: { user_phone_number: phone },
  };
}

export function createCaller({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 15000, log = () => {} } = {}) {
  async function call({ phone, reminderText, userName }) {
    const missing = missingConfig(env);
    if (missing.length) return { ok: false, error: 'not_configured', missing };
    if (!E164.test(String(phone ?? ''))) return { ok: false, error: 'bad_phone' };
    const text = String(reminderText ?? '').trim().slice(0, 240);
    if (!text) return { ok: false, error: 'empty_reminder' };
    const name = String(userName ?? '').trim().slice(0, 60) || 'friend';
    const url = `${BASE}/orgs/${encodeURIComponent(env.SARVAM_VOICE_ORG_ID.trim())}/workspaces/${encodeURIComponent(env.SARVAM_VOICE_WORKSPACE_ID.trim())}/outbounds`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-API-Key': env.SARVAM_VOICE_API_KEY.trim() },
        body: JSON.stringify(buildCallBody(env, { phone, reminderText: text, userName: name })),
        signal: ctl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { log(`[call] upstream ${res.status}`); return { ok: false, error: 'upstream_error', status: res.status }; }
      return { ok: true, attemptId: data.attempt_id ?? null };
    } catch (e) {
      log(`[call] ${e.name === 'AbortError' ? 'timeout' : e.message}`);
      return { ok: false, error: 'unreachable' };
    } finally {
      clearTimeout(timer);
    }
  }
  return { call, missing: () => missingConfig(env) };
}
