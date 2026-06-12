/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Safety gate for one-click unsubscribe URLs. List-Unsubscribe headers are
// sender-supplied, and the one-click flow POSTs to them without showing the
// user a page first — so a forged header must not be able to aim a request
// at localhost, the user's LAN, or other internal infrastructure.
//
// RFC 8058 §3.1 requires the POST URI to use https, so the https-only rule
// costs no legitimate sender anything. Hostname checks run on the WHATWG
// URL parser's canonical form, which already normalizes decimal/octal/hex
// IPv4 notations ("https://2130706433/" parses to hostname "127.0.0.1").
// DNS rebinding (a public name resolving to a private address) cannot be
// detected here; this gate covers what is checkable without resolving DNS.

const PRIVATE_IPV4 = [
  /^0\./,                                       // "this network"
  /^10\./,                                      // RFC 1918
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,   // CGNAT 100.64/10
  /^127\./,                                     // loopback
  /^169\.254\./,                                // link-local
  /^172\.(1[6-9]|2\d|3[01])\./,                 // RFC 1918
  /^192\.168\./                                 // RFC 1918
];

// Shared gate. `allowHttp` lets the browser-opened methods accept http://
// (some senders still link plain http unsubscribe pages); the one-click
// POST stays https-only per RFC 8058. The host checks are identical for
// both: opening http://192.168.1.1/… in a browser can still trigger a
// CSRF-style GET against a LAN device, and a legitimate mailing list never
// hosts its unsubscribe page on localhost or a private address.
function urlBlockReason(rawUrl, { allowHttp }) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch (e) {
    return 'not a valid URL';
  }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    return allowHttp
      ? 'unsubscribe links must use http(s)'
      : 'one-click unsubscribe requires an https:// URL (RFC 8058)';
  }

  let host = url.hostname.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);

  if (host.startsWith('[')) {
    const v6 = host.slice(1, -1);
    if (v6 === '::' || v6 === '::1') return 'IPv6 loopback address';
    if (/^f[cd]/.test(v6)) return 'private IPv6 address';
    if (/^fe[89ab]/.test(v6)) return 'link-local IPv6 address';
    if (v6.startsWith('::ffff:')) return 'IPv4-mapped IPv6 address';
    return null;
  }

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    if (PRIVATE_IPV4.some(range => range.test(host))) return 'private or local IPv4 address';
    return null;
  }

  if (host === 'localhost' || host.endsWith('.localhost')) return 'localhost';
  if (!host.includes('.')) return 'single-label (intranet) hostname';
  if (/\.(local|internal|home\.arpa)$/.test(host)) return 'internal-network hostname';
  return null;
}

// One-click POST: https only, public host.
export function oneClickUrlBlockReason(rawUrl) {
  return urlBlockReason(rawUrl, { allowHttp: false });
}

// Web / embedded-link methods opened in the default browser: http or https,
// still refusing localhost/private/internal destinations.
export function browserUrlBlockReason(rawUrl) {
  return urlBlockReason(rawUrl, { allowHttp: true });
}
