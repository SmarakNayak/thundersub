import test from 'node:test';
import assert from 'node:assert/strict';

import {
  registrableDomain, targetHost, sendingService, parseAuthResults, messageAuthStatus,
  emptySenderAuth, addSenderAuth, nameMatchesSender, checkUnsubTarget, addressInLink
} from '../sender-check.js';

const tally = (...messages) => messages.reduce(
  (t, [headers, from, date]) => addSenderAuth(t, messageAuthStatus(headers, from), date), emptySenderAuth());

test('registrable domain keeps two labels, three under multi-label suffixes', () => {
  assert.equal(registrableDomain('news.Shop.Example.'), 'shop.example');
  assert.equal(registrableDomain('mail.news.shop.de'), 'shop.de');
  assert.equal(registrableDomain('email.brand.co.uk'), 'brand.co.uk');
  assert.equal(registrableDomain('brand.co.uk'), 'brand.co.uk');
  assert.equal(registrableDomain('192.0.2.7'), '192.0.2.7');
});

test('target host is the web host or the mailto domain', () => {
  assert.equal(targetHost('https://Click.Shop.de/u?x=1'), 'click.shop.de');
  assert.equal(targetHost('mailto:unsub%2B42@lists.shop.de?subject=unsubscribe'), 'lists.shop.de');
  assert.equal(targetHost('not a url'), '');
});

test('sending services are recognised by name and by pattern', () => {
  assert.equal(sendingService('u123.ct.sendgrid.net'), 'SendGrid');
  assert.equal(sendingService('cl.s7.exct.net'), 'Salesforce Marketing Cloud');
  assert.equal(sendingService('links.mkt5558.com'), 'Acoustic');
  assert.equal(sendingService('shop.de'), null);
});

test('parses Authentication-Results with comments and spaced equals signs', () => {
  const parsed = parseAuthResults('gmx.net; dkim=pass (2048-bit key) header.i=@shop.de header.s=s1; ' +
    'spf=pass smtp.mailfrom =bounce@shop.de; dmarc=pass header.from=news.shop.de policy.dmarc=reject');
  assert.equal(parsed.authservId, 'gmx.net');
  assert.deepEqual(parsed.results.map(r => `${r.method}=${r.result}`), ['dkim=pass', 'spf=pass', 'dmarc=pass']);
  assert.equal(parsed.results[1].props['smtp.mailfrom'], 'bounce@shop.de');
  assert.equal(parsed.results[2].props['header.from'], 'news.shop.de');
});

test('DMARC pass or a DKIM signature by the From domain verifies the sender', () => {
  assert.equal(messageAuthStatus(
    ['gmx.net; dkim=pass header.i=@esp.example; dmarc=pass header.from=news.shop.de'], 'a@news.shop.de').status, 'pass');
  assert.equal(messageAuthStatus(['mx.example; dkim=pass header.d=shop.de'], 'a@news.shop.de').status, 'pass');
  assert.equal(messageAuthStatus(['mx.example; dkim=pass header.i=info@mail.shop.de'], 'a@shop.de').status, 'pass');
});

test('signatures by someone else, failures and missing results do not verify', () => {
  assert.deepEqual(messageAuthStatus(['gmx.net; dkim=pass header.i=@relay.example'], 'a@shop.de'),
    { status: 'third-party', signers: ['relay.example'] });
  assert.equal(messageAuthStatus(['gmx.net; dkim=fail header.i=@shop.de'], 'a@shop.de').status, 'fail');
  assert.equal(messageAuthStatus(['gmx.net; dmarc=fail header.from=shop.de'], 'a@shop.de').status, 'fail');
  assert.equal(messageAuthStatus(['gmx.net; dkim=none'], 'a@shop.de').status, 'none');
  assert.equal(messageAuthStatus([], 'a@shop.de').status, 'none');
  assert.equal(messageAuthStatus(undefined, 'a@shop.de').status, 'none');
});

test('only headers from the receiving server count', () => {
  // One header per signature, all from the receiving server.
  assert.equal(messageAuthStatus(
    ['gmx.net; dkim=pass header.i=@esp.example', 'gmx.net; dkim=pass header.i=@shop.de'], 'a@shop.de').status, 'pass');
  // A header that came with the message under another id is ignored.
  assert.equal(messageAuthStatus(
    ['gmx.net; dkim=none', 'forged.example; dkim=pass header.d=shop.de'], 'a@shop.de').status, 'none');
});

test('the tally reports the newest message and collects signers', () => {
  const t = tally(
    [['gmx.net; dkim=pass header.i=@esp.example'], 'a@shop.de', '2026-01-01T00:00:00.000Z'],
    [['gmx.net; dmarc=pass header.from=shop.de'], 'a@shop.de', '2026-03-01T00:00:00.000Z'],
    [[], 'a@shop.de', '2025-01-01T00:00:00.000Z']);
  assert.equal(t.latest, 'pass');
  assert.deepEqual([t.pass, t['third-party'], t.none], [1, 1, 1]);
  assert.deepEqual(t.signers, ['esp.example']);
});

test('display name has to fit the domain, or the mailbox name on free mail', () => {
  assert.equal(nameMatchesSender('Shop Newsletter', 'news@mail.shop.de'), true);
  assert.equal(nameMatchesSender('Brand VIP', 'info@admk.hijacked-store.de'), false);
  assert.equal(nameMatchesSender('M e d i a S h o p', 'x123@gmx.com'), false);
  assert.equal(nameMatchesSender('Erika Muster', 'erika.muster@gmx.net'), true);
  assert.equal(nameMatchesSender('Kundenservice Premium', 'info@agency.gov.uk'), null);
  assert.equal(nameMatchesSender('', 'info@shop.de'), null);
});

test('links on the sender domain, a sister domain or a sending service are fine', () => {
  const verified = tally([['gmx.net; dmarc=pass header.from=shop.de'], 'news@shop.de', '2026-01-01']);
  const same = checkUnsubTarget({ url: 'https://www.shop.de/unsub', senderEmail: 'news@mail.shop.de', senderName: 'Shop', senderAuth: verified });
  assert.equal(same.relation, 'same');
  assert.equal(same.verified, true);
  assert.equal(same.recommendJunk, false);

  assert.equal(checkUnsubTarget({ url: 'https://www.shop.com/u', senderEmail: 'news@shop.de' }).relation, 'same');
  assert.equal(checkUnsubTarget({ url: 'https://www.reviewsite.com/u', senderEmail: 'x@reviewsitemail.com' }).relation, 'same');

  const service = checkUnsubTarget({ url: 'https://u1.ct.sendgrid.net/ls/click?upn=x', senderEmail: 'news@shop.de', senderName: 'Shop' });
  assert.equal(service.relation, 'service');
  assert.equal(service.service, 'SendGrid');
  assert.equal(service.recommendJunk, false);
});

test('a foreign link from a hijacked domain with a borrowed name is junk', () => {
  // Real pattern: signed correctly by the hijacked domain, name of another brand.
  const auth = tally([['gmx.net; dkim=pass header.i=@hijacked-store.de; dmarc=pass header.from=admk.hijacked-store.de'],
    'info@admk.hijacked-store.de', '2026-08-12']);
  const check = checkUnsubTarget({
    url: 'https://phish.example/abmelden', senderEmail: 'info@admk.hijacked-store.de', senderName: 'Brand VIP', senderAuth: auth
  });
  assert.equal(check.relation, 'foreign');
  assert.equal(check.verified, true);
  assert.deepEqual(check.junkReasons, ['name']);
  assert.equal(check.recommendJunk, true);
});

test('foreign links: free mail posing as a company and failed signatures are junk', () => {
  const freemail = checkUnsubTarget({ url: 'https://bucket.example/x', senderEmail: 'x123@gmx.com', senderName: 'Shop Deals' });
  assert.deepEqual(freemail.junkReasons, ['freemail']);

  const person = checkUnsubTarget({ url: 'https://shop.example/x', senderEmail: 'erika.muster@gmx.net', senderName: 'Erika Muster' });
  assert.equal(person.recommendJunk, false);

  const failed = tally([['gmx.net; dkim=fail header.i=@shop.de'], 'a@shop.de', '2026-01-01']);
  assert.deepEqual(checkUnsubTarget({ url: 'https://other.example/u', senderEmail: 'a@shop.de', senderName: 'Shop', senderAuth: failed }).junkReasons,
    ['failed']);
  const relayed = tally([['gmx.net; dkim=pass header.i=@relay.example'], 'a@shop.de', '2026-01-01']);
  assert.deepEqual(checkUnsubTarget({ url: 'https://other.example/u', senderEmail: 'a@shop.de', senderName: 'Shop', senderAuth: relayed }).junkReasons,
    ['unverified']);
});

test('a foreign link without any signature result is shown but not called junk', () => {
  const none = tally([[], 'a@shop.de', '2020-01-01']);
  const check = checkUnsubTarget({ url: 'https://partner.example/u', senderEmail: 'a@shop.de', senderName: 'Shop', senderAuth: none });
  assert.equal(check.relation, 'foreign');
  assert.equal(check.verified, null);
  assert.equal(check.recommendJunk, false);
  assert.equal(checkUnsubTarget({ url: 'https://partner.example/u', senderEmail: 'a@shop.de', senderName: 'Shop' }).verified, null);
});

test('hostile header values are cut off, not trusted', () => {
  assert.equal(messageAuthStatus('gmx.net; dkim=pass header.d=shop.de', 'a@shop.de').status, 'none');
  assert.equal(messageAuthStatus([null, 42], 'a@shop.de').status, 'none');
  assert.equal(messageAuthStatus([';;;=;(((', 'x'], 'a@shop.de').status, 'none');
  const padded = 'gmx.net; ' + 'x=y '.repeat(5000) + '; dkim=pass header.d=shop.de';
  assert.equal(messageAuthStatus([padded], 'a@shop.de').status, 'none');
  const many = Array.from({ length: 1000 }, () => 'gmx.net; dkim=none');
  many.push('gmx.net; dkim=pass header.d=shop.de');
  assert.equal(messageAuthStatus(many, 'a@shop.de').status, 'none');
  assert.equal(nameMatchesSender('a '.repeat(100000), 'a@shop.de'), false);
  assert.equal(checkUnsubTarget({ url: 'javascript:alert(1)', senderEmail: 'a@shop.de' }).relation, 'unknown');
  assert.equal(checkUnsubTarget({}).relation, 'unknown');
});

test('plain http links are flagged, with the recipient address when it is in them', () => {
  const me = ['reader@example.net', ''];
  const plain = checkUnsubTarget({ url: 'http://shop.de/unsub?email=reader%40example.net', senderEmail: 'a@shop.de', recipientAddresses: me });
  assert.equal(plain.insecure, true);
  assert.equal(plain.addressInLink, 'reader@example.net');

  const twice = 'http://t.example/r?url=' + encodeURIComponent('https://shop.de/u?e=' + encodeURIComponent('Reader@Example.net'));
  assert.equal(addressInLink(twice, me), 'reader@example.net');

  const opaque = checkUnsubTarget({ url: 'HTTP://shop.de/u?id=8f3a', senderEmail: 'a@shop.de', recipientAddresses: me });
  assert.equal(opaque.insecure, true);
  assert.equal(opaque.addressInLink, null);

  const tls = checkUnsubTarget({ url: 'https://shop.de/u?email=reader@example.net', senderEmail: 'a@shop.de', recipientAddresses: me });
  assert.equal(tls.insecure, false);
  assert.equal(addressInLink('http://shop.de/%E0%A4%A', me), null);
});

test('via a sending service only a failed signature or posing free mail is junk', () => {
  const failed = tally([['gmx.net; dkim=fail header.i=@school.example'], 'x@school.example', '2025-05-22']);
  const spam = checkUnsubTarget({ url: 'https://writer.substack.com/action/disable_email', senderEmail: 'x@school.example',
    senderName: 'Diet Trend', senderAuth: failed });
  assert.equal(spam.relation, 'service');
  assert.deepEqual(spam.junkReasons, ['failed']);

  // The service signs instead of the sender, and the name is a game, not the domain: normal.
  const relayed = tally([['gmx.net; dkim=pass header.i=@sendinblue.com'], 'news@game-studio.example', '2026-01-01']);
  const legit = checkUnsubTarget({ url: 'https://x.r.sp1-brevo.net/u', senderEmail: 'news@game-studio.example',
    senderName: 'Castle Online', senderAuth: relayed });
  assert.equal(legit.relation, 'service');
  assert.equal(legit.nameMatch, false);
  assert.equal(legit.recommendJunk, false);

  assert.deepEqual(checkUnsubTarget({ url: 'https://x.klclick.com/u', senderEmail: 'a1b2@x.onmicrosoft.com', senderName: 'Shop Team' }).junkReasons,
    ['freemail']);
});

test('umlauts match either spelling in the domain', () => {
  assert.equal(nameMatchesSender('Möbel KÖHLER', 'news@koehler.de'), true);
  assert.equal(nameMatchesSender('Müller Shop', 'info@muller.example'), true);
});

test('via a sending service, a borrowed name without List-Unsubscribe header is junk', () => {
  const signed = tally([['gmx.net; dmarc=pass header.from=club.example'], 'x@mail.club.example', '2026-07-16']);
  const args = { url: 'https://e.customeriomail.com/u/abc', senderEmail: 'x@mail.club.example', senderName: 'Antivirus Alerts', senderAuth: signed };
  assert.deepEqual(checkUnsubTarget({ ...args, listUnsubscribe: false }).junkReasons, ['name']);
  assert.equal(checkUnsubTarget({ ...args, listUnsubscribe: true }).recommendJunk, false);
  assert.equal(checkUnsubTarget(args).recommendJunk, false);
  assert.equal(sendingService('lists.acemsc2.com'), 'ActiveCampaign');
});
