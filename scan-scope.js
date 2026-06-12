/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Sender skip patterns for the scan scope, matched case-insensitively
// against the message's From address:
//   spammer.com         the domain and all of its subdomains
//   phish@spammer.com   exact address
//   *@spammer.com       that domain only ("@spammer.com" works too)
//   *@*.spammer.com     subdomains only (DNS/TLS-wildcard reading)
// The bare domain is the everyday "block this org" form; the * forms are
// strict globs for narrowing. Suffix matching respects label boundaries:
// spammer.com never matches evilspammer.com.

// Three shapes: exact-or-*-or-empty local part with a plain domain;
// *-or-empty local part with a *.-prefixed domain; or a bare domain
// containing at least one dot. tab.js validates modal input against the
// same shape — keep them in sync.
export const SENDER_PATTERN_REGEX = /^((\*|[^\s@*]*)@[^\s@*]+|\*?@\*\.[^\s@*]+|[^\s@*]+\.[^\s@*]+)$/;

export function isValidSenderPattern(pattern) {
  return SENDER_PATTERN_REGEX.test(String(pattern || '').trim());
}

// Returns a matcher function over lowercased sender addresses, or null when
// no usable patterns exist so callers can skip the check entirely.
export function buildSenderSkipMatcher(patterns) {
  const emails = new Set();
  const domains = new Set();           // matches the domain exactly
  const subdomainSuffixes = new Set(); // matches below the domain only
  for (const raw of patterns || []) {
    const pattern = String(raw || '').trim().toLowerCase();
    if (!isValidSenderPattern(pattern)) continue;
    const at = pattern.indexOf('@');
    if (at === -1) {
      // Bare domain: the domain itself and everything under it.
      domains.add(pattern);
      subdomainSuffixes.add(pattern);
      continue;
    }
    const local = pattern.slice(0, at);
    const domain = pattern.slice(at + 1);
    if (domain.startsWith('*.')) subdomainSuffixes.add(domain.slice(2));
    else if (local === '*' || local === '') domains.add(domain);
    else emails.add(pattern);
  }
  if (emails.size === 0 && domains.size === 0 && subdomainSuffixes.size === 0) return null;
  return (email) => {
    const address = String(email || '').toLowerCase();
    if (emails.has(address)) return true;
    const at = address.lastIndexOf('@');
    if (at === -1) return false;
    let domain = address.slice(at + 1);
    if (domains.has(domain)) return true;
    // Strip at least one label before consulting the subdomain suffixes, so
    // they only ever match strictly below their domain.
    while (true) {
      const dot = domain.indexOf('.');
      if (dot === -1) return false;
      domain = domain.slice(dot + 1);
      if (subdomainSuffixes.has(domain)) return true;
    }
  };
}
