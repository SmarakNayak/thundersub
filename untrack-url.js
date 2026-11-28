/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Strips click-tracking from unsubscribe links before they are opened in the
// browser. Newsletters wrap every body link in a redirector (Amazon SES
// awstrack.me, Mailgun, Outlook safelinks, ?url=/redirect= style trackers), and many
// tracker blockers rightly refuse to open those. Most redirectors carry the
// real destination inside the link itself, so it can be unwrapped offline,
// without ever contacting the tracker. Opaque trackers (only an ID, no
// destination in the link) are left untouched.
//
// Only applied to links opened in the browser. One-click POSTs go to the
// List-Unsubscribe header URL exactly as the sender published it.
//
// The result must still pass browserUrlBlockReason(): an unwrapped
// destination is just as sender-controlled as the original link.

const MAX_HOPS = 8;
// Cap for inflated path data, so a crafted link cannot decompress into megabytes.
const MAX_INFLATED_BYTES = 64 * 1024;

// Query parameters that only count clicks. Deliberately short: leaving a
// counter in place is harmless, breaking an unsubscribe token is not.
// (Marketo's mkt_tok is NOT listed: its unsubscribe pages use it to identify
// the subscriber.)
const TRACKING_PARAM = new RegExp(
  '^(utm_\\w+|fbclid|gclid|gbraid|wbraid|dclid|msclkid|yclid|igshid|twclid|ttclid|li_fat_id|' +
  'mc_cid|mc_eid|_hsenc|_hsmi|__hssc|__hstc|__hsfp|hsctatracking|oly_anon_id|oly_enc_id|' +
  'vero_conv|vero_id|wickedid|_kx|ss_source|ss_campaign_id|sc_campaign|sc_channel|cmpid|ncid)$',
  'i'
);

// Parameters redirectors put their destination in (Google: q, safelinks: url).
const TARGET_PARAMS = ['url', 'u', 'q', 'target', 'redirect', 'redirect_url', 'redirect_uri', 'redir',
  'link', 'dest', 'destination', 'to', 'goto', 'out', 'r', 'l', 'href'];

const isHttpUrl = (text) => /^https?:\/\/[^/\s]+/i.test(text);

// Only characters RFC 3986 allows in a URL. Decoded base64 that yields
// anything else was decoded with the wrong alphabet and must not be opened.
const isCleanUrl = (text) => isHttpUrl(text) && /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/.test(text);

function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch (e) {
    return text;
  }
}

async function inflateBounded(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total > MAX_INFLATED_BYTES) {
      await reader.cancel();
      return null;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function decodeBase64(b64) {
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  let bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  if (bytes[0] === 0x78) {
    bytes = await inflateBounded(bytes);
    if (!bytes) return null;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

// Decodes a base64 path segment, inflating it first when it is zlib data
// (Mailgun click links: /c/eJx…). Senders disagree on the URL-safe alphabet
// ('-' stands for '+' in RFC 4648, Stardock uses it for '/'), so both readings
// are returned when they differ; the caller keeps the one that yields a valid URL.
async function decodePathSegment(segment) {
  if (segment.length < 16 || !/^[A-Za-z0-9+/_=-]+$/.test(segment)) return [];
  const alphabets = [segment.replace(/-/g, '+').replace(/_/g, '/')];
  if (/[-_]/.test(segment)) alphabets.push(segment.replace(/-/g, '/').replace(/_/g, '+'));
  const texts = [];
  for (const b64 of alphabets) {
    try {
      const text = await decodeBase64(b64);
      if (text) texts.push(text);
    } catch (e) {
      // not base64 in this alphabet
    }
  }
  return texts;
}

function targetInPairs(pairs) {
  const named = pairs.find(([name, value]) => TARGET_PARAMS.includes(name.toLowerCase()) && isHttpUrl(value));
  if (named) return named[1];
  const any = pairs.find(([, value]) => isHttpUrl(value));
  return any ? any[1] : null;
}

// Finds the destination in decoded path data: the URL itself, a JSON object
// or a query string (Mailgun v2 packs "…&l=<destination>&r=<recipient>…").
function targetInText(text) {
  const trimmed = text.trim();
  if (isHttpUrl(trimmed)) return trimmed;
  try {
    const data = JSON.parse(trimmed);
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return targetInPairs(Object.entries(data).filter(([, value]) => typeof value === 'string'));
    }
  } catch (e) {
    // not JSON
  }
  if (trimmed.includes('=')) return targetInPairs([...new URLSearchParams(trimmed)]);
  return null;
}

// Returns the destination a redirector carries inside the link, or null.
export async function embeddedTarget(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch (e) {
    return null;
  }

  const fromQuery = targetInPairs([...url.searchParams]);
  if (fromQuery) return fromQuery;

  // Destination encoded in a path segment, e.g.
  // awstrack.me/L0/https:%2F%2Fexample.com%2Funsub%3Fq=…/1/<message-id>/<signature>
  // or base64 (optionally zlib-packed) like Mailgun's /c/eJx…
  for (const segment of url.pathname.split('/')) {
    const decoded = safeDecode(segment);
    if (isHttpUrl(decoded)) return decoded;
    for (const text of await decodePathSegment(segment)) {
      const target = targetInText(text);
      if (target && isCleanUrl(target)) return target;
    }
  }

  // Destination appended raw: …/redirect/https://example.com/…
  const raw = /\/(https?:\/{1,2}[^/].*)$/i.exec(url.pathname + url.search);
  if (raw) return raw[1].replace(/^(https?:)\/(?!\/)/i, '$1//');
  return null;
}

// Removes counting parameters, leaving every other byte of the query alone so
// that tokens keep their exact encoding.
export function stripTrackingParams(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch (e) {
    return rawUrl;
  }
  const pairs = url.search.replace(/^\?/, '').split('&').filter(Boolean);
  const kept = pairs.filter((pair) => !TRACKING_PARAM.test(safeDecode(pair.split('=')[0].replace(/\+/g, ' '))));
  const dropFragment = /^utm_/i.test(url.hash.replace(/^#/, ''));
  if (kept.length === pairs.length && !dropFragment) return rawUrl;
  url.search = kept.length ? '?' + kept.join('&') : '';
  if (dropFragment) url.hash = '';
  return url.href;
}

// Unwraps nested redirectors offline, then strips counting parameters.
export async function untrackUrl(rawUrl) {
  let current = rawUrl;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const next = await embeddedTarget(current);
    if (!next || next === current) break;
    current = next;
  }
  return stripTrackingParams(current);
}
