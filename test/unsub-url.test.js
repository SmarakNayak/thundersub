import test from 'node:test';
import assert from 'node:assert/strict';

import { oneClickUrlBlockReason } from '../unsub-url.js';

const ok = (url) => assert.equal(oneClickUrlBlockReason(url), null, `expected allowed: ${url}`);
const blocked = (url) => assert.ok(oneClickUrlBlockReason(url), `expected blocked: ${url}`);

test('allows public https endpoints', () => {
  ok('https://unsubscribe.example.com/u/abc123');
  ok('https://example.com:8443/unsub?id=1');
  ok('https://example.co.uk./u');           // trailing-dot FQDN
  ok('https://8.8.8.8/u');                  // public IP literal: unusual but routable
});

test('rejects non-https schemes (RFC 8058 requires https)', () => {
  blocked('http://unsubscribe.example.com/u');
  blocked('ftp://example.com/u');
  blocked('mailto:unsub@example.com');
  blocked('not a url at all');
});

test('rejects localhost and internal hostnames', () => {
  blocked('https://localhost/u');
  blocked('https://localhost:8080/u');
  blocked('https://api.localhost/u');
  blocked('https://router/u');              // single-label intranet name
  blocked('https://nas.local/u');
  blocked('https://printer.internal/u');
  blocked('https://gw.home.arpa/u');
});

test('rejects private and reserved IPv4 ranges', () => {
  for (const ip of ['127.0.0.1', '127.1.2.3', '0.0.0.0', '10.0.0.1', '10.255.255.255',
                    '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
                    '100.64.0.1', '100.127.255.255']) {
    blocked(`https://${ip}/u`);
  }
  // Range boundaries that are public again.
  for (const ip of ['172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1', '11.0.0.1']) {
    ok(`https://${ip}/u`);
  }
});

test('rejects obfuscated IPv4 notations via URL canonicalization', () => {
  blocked('https://2130706433/u');          // decimal 127.0.0.1
  blocked('https://0x7f000001/u');          // hex 127.0.0.1
  blocked('https://0177.0.0.1/u');          // octal first byte
});

test('rejects local IPv6 literals', () => {
  blocked('https://[::1]/u');
  blocked('https://[::]/u');
  blocked('https://[fc00::1]/u');
  blocked('https://[fd12:3456::1]/u');
  blocked('https://[fe80::1]/u');
  blocked('https://[::ffff:127.0.0.1]/u');  // IPv4-mapped
  ok('https://[2606:4700::6810:84e5]/u');   // public IPv6 stays allowed
});
