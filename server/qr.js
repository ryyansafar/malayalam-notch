// QR code SVG rendering (qrcode-generator, loaded lazily) and the two small
// server-rendered pages: the landing page that shows the QR and a message page.

export const QR_URL_MAX = 512;

export class QrUnavailableError extends Error {
  constructor(message = 'QR generator is not installed') {
    super(message);
    this.name = 'QrUnavailableError';
  }
}

/**
 * @param {unknown} raw value of the url query parameter
 * @returns {{ ok: true, url: string } | { ok: false, message: string }}
 */
export function validateQrUrl(raw) {
  if (typeof raw !== 'string' || raw === '') return { ok: false, message: 'Query parameter "url" is required' };
  if (raw.length > QR_URL_MAX) {
    return { ok: false, message: `Query parameter "url" must be at most ${QR_URL_MAX} characters` };
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, message: 'Query parameter "url" must be an absolute URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, message: 'Query parameter "url" must use http or https' };
  }
  return { ok: true, url: parsed.href };
}

// Dark modules on a white background with a quiet zone, as scanners expect.
export function matrixToSvg(count, isDark, { margin = 4 } = {}) {
  const size = count + margin * 2;
  const parts = [];
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (isDark(row, col)) parts.push(`M${col + margin} ${row + margin}h1v1h-1z`);
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size * 8}" height="${size * 8}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="QR code">` +
    `<rect width="${size}" height="${size}" fill="#ffffff"/><path fill="#000000" d="${parts.join('')}"/></svg>`
  );
}

/**
 * @param {() => Promise<unknown>} [loader] resolves the qrcode-generator module
 * @returns {(url: string) => Promise<string>} renders a validated URL as SVG text
 */
export function createQrRenderer(loader = () => import('qrcode-generator')) {
  let factory = null;
  return async function renderQr(url) {
    if (!factory) {
      let mod;
      try {
        mod = await loader();
      } catch {
        throw new QrUnavailableError('QR generator is not installed. Run npm install.');
      }
      const candidate = mod && typeof mod.default === 'function' ? mod.default : mod;
      if (typeof candidate !== 'function') throw new QrUnavailableError('QR generator module has an unexpected shape');
      factory = candidate;
    }
    const qr = factory(0, 'M');
    qr.addData(url);
    qr.make();
    return matrixToSvg(qr.getModuleCount(), (row, col) => qr.isDark(row, col));
  };
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const PAGE_CSS = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0a0a0a;color:#f2f2ee;font-family:"Space Grotesk",system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.45}
main{max-width:60rem;margin:0 auto;padding:clamp(1.5rem,5vw,4rem) 1.25rem}
h1{font-size:clamp(3rem,12vw,7rem);line-height:.9;letter-spacing:-.04em;margin:0 0 1rem}
p{margin:0 0 1rem;max-width:40rem}
a{color:#f2f2ee;text-underline-offset:.2em}
a:focus-visible{outline:2px solid #f2f2ee;outline-offset:3px}
.muted{color:#a9ab9f}
.badge{display:inline-block;padding:.2rem .7rem;border:1px solid #f2f2ee;font-size:.85rem;letter-spacing:.14em;font-weight:700}
.badge.replay{border-color:#e0a030;color:#e0a030}
.badge.live{border-color:#5fd068;color:#5fd068}
.grid{display:grid;gap:2rem;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr));align-items:start;margin:2.5rem 0}
.qr{width:100%;max-width:20rem;height:auto;display:block;background:#fff}
.cta{display:inline-block;margin:.5rem 0 1rem;padding:.9rem 1.4rem;background:#464A39;color:#f2f2ee;text-decoration:none;font-size:1.25rem;font-weight:700}
.notice{border-left:4px solid #e0a030;padding:.6rem 1rem;margin:2rem 0}
code{font-family:ui-monospace,Menlo,monospace;font-size:.95em;word-break:break-all}
footer{margin-top:3rem;padding-top:1rem;border-top:1px solid #464A39;font-size:.9rem}
footer a{margin-right:1rem;display:inline-block}
`;

function page(title, body) {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escapeHtml(title)}</title><style>${PAGE_CSS}</style></head><body><main>${body}</main></body></html>`
  );
}

const SUPPORT_LINKS = [
  ['Portfolio', 'https://ryyansafar.site'],
  ['GitHub', 'https://github.com/ryyansafar'],
  ['Buy Me a Coffee', 'https://buymeacoffee.com/ryyansafar'],
  ['PayPal', 'https://www.paypal.com/paypalme/ryyansafar'],
  ['Razorpay', 'https://razorpay.me/@ryyansafar'],
];

/**
 * @param {{ phoneUrl: string, otherPhoneUrls?: string[], mode: string, https: boolean }} view
 * @returns {string} landing page HTML
 */
export function landingPage({ phoneUrl, otherPhoneUrls = [], mode, https }) {
  const live = mode === 'live';
  const others = otherPhoneUrls
    .map((u) => `<br><code>${escapeHtml(u)}</code>`)
    .join('');
  const httpsNote = https
    ? ''
    : '<p class="muted">Served over HTTP: phone motion sensors usually need HTTPS, so the phone page may fall back to its labelled simulation.</p>';
  const links = SUPPORT_LINKS.map(
    ([label, href]) => `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${escapeHtml(label)}</a>`,
  ).join('');
  return page(
    'rowing-call',
    `<h1>rowing-call</h1>
<p>The phone is the oar. A shouted Malayalam work call is translated, spoken to the rower in their language, and the stroke rate shows whether the rower obeyed.</p>
<p class="muted">An induction and classroom drill, not race equipment.</p>
<p>Sarvam mode: <span class="badge ${live ? 'live' : 'replay'}">${live ? 'LIVE' : 'REPLAY'}</span></p>
<div class="grid">
<section aria-labelledby="phone-h"><h2 id="phone-h">Phone: scan to row</h2>
<img class="qr" alt="QR code that opens the phone page" src="/qr.svg?url=${encodeURIComponent(phoneUrl)}">
<p><code>${escapeHtml(phoneUrl)}</code>${others}</p>${httpsNote}</section>
<section aria-labelledby="dash-h"><h2 id="dash-h">Laptop</h2>
<a class="cta" href="/dashboard">Open the dashboard</a>
<p class="muted">Shout box, live stroke rate, obedience result and the evidence table.</p></section>
</div>
<p class="notice">Call table is placeholder: real race calls not yet collected (UNVERIFIED). Spoken phrases are not yet reviewed by native speakers.</p>
<footer><span class="muted">Built at Hackathoni by ryyansafar.</span><br>${links}</footer>`,
  );
}

/**
 * @param {{ title: string, detail: string }} view
 * @returns {string} a plain message page (used for 404 and similar)
 */
export function messagePage({ title, detail }) {
  return page(
    title,
    `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p><p><a href="/">Back to the start page</a></p>`,
  );
}

/**
 * @param {{ title: string, detail: string, form?: { action: string, token: string, label: string } | null }} view
 * @returns {string} the answer page of the /share share-target, with an optional one-button form
 */
export function sharePage({ title, detail, form = null }) {
  const button = form
    ? `<form method="post" action="${escapeHtml(form.action)}">` +
      `<input type="hidden" name="token" value="${escapeHtml(form.token)}">` +
      `<button class="cta" type="submit">${escapeHtml(form.label)}</button></form>`
    : '';
  return page(
    title,
    `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>${button}<p><a href="/phone">Back to the phone page</a></p>`,
  );
}
