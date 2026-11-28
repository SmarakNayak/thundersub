import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';

import { untrackUrl, embeddedTarget, stripTrackingParams } from '../untrack-url.js';

test('unwraps Amazon SES awstrack.me links without touching the token', async () => {
  const target = 'https://moe_abc.api-02.moengage.com/v1/emailunsubscribe?q=xmaf-T.EXI_Ne.4I.0zE';
  const wrapped = 'https://m4zpmg5b.r.us-east-1.awstrack.me/L0/' +
    encodeURIComponent(target).replace('%3A', ':') +
    '/1/010001a222cde4ec-aa256a37-dec3-4fd8-86b0-55ca61742944-000000/7JhK1_62fnMlQGwQseonVJagyDk=473';
  assert.equal(await untrackUrl(wrapped), target);
});

test('unwraps Mailgun click links (zlib-packed query string in the path)', async () => {
  const target = 'https://shop.example/?action=newsletter_unsubscribe&email=reader%40example.net&sid=e425';
  const packed = 'd=5f0953&e=1795742830&h=d458603cfd8a9c41&i=20261127.e3e3%40n.shop.example' +
    `&l=${encodeURIComponent(target)}&r=reader%40example.net&t=newsletter_6196&v=2`;
  const wrapped = `https://email.n.shop.example/c/${deflateSync(packed).toString('base64url')}`;
  assert.equal(await untrackUrl(wrapped), target);
});

test('unwraps base64 JSON destinations in the path', async () => {
  const json = JSON.stringify({ email_id: 'abc', href: 'https://list.example/u?t=1&utm_medium=email' });
  const wrapped = `https://t.example/e/c/${Buffer.from(json).toString('base64url')}/sig`;
  assert.equal(await untrackUrl(wrapped), 'https://list.example/u?t=1');
});

test('accepts base64 that uses - for / (Stardock) and refuses garbled results', async () => {
  const target = 'https://shop.example/accounts/unsubscribex.aspx?email=reader%40example.net&list=16,37&utm_source=promo';
  const std = Buffer.from(target).toString('base64');
  assert.ok(std.includes('/'), 'fixture must exercise the / character');
  const stardock = std.replace(/\//g, '-');
  assert.equal(await untrackUrl(`https://t.example/clickemail/t/${stardock}`),
    'https://shop.example/accounts/unsubscribex.aspx?email=reader%40example.net&list=16,37');
});

test('keeps Marketo mkt_tok, which identifies the subscriber on unsubscribe pages', () => {
  const url = 'https://info.example.com/UnsubscribePage.html?mkt_unsubscribe=1&mkt_tok=NDI2LVFW';
  assert.equal(stripTrackingParams(url), url);
});

test('refuses path data that inflates beyond the size cap', async () => {
  const bomb = deflateSync('https://x.example/' + 'a'.repeat(10_000_000)).toString('base64url');
  const url = `https://t.example/c/${bomb}`;
  assert.equal(await embeddedTarget(url), null);
  assert.equal(await untrackUrl(url), url);
});

test('ignores corrupt zlib data', async () => {
  const corrupt = 'eJx' + 'A'.repeat(40);
  const url = `https://t.example/c/${corrupt}`;
  assert.equal(await untrackUrl(url), url);
});

test('unwraps Outlook safelinks and strips utm parameters', async () => {
  const wrapped = 'https://eur01.safelinks.protection.outlook.com/?url=' +
    encodeURIComponent('https://shop.example/unsub?token=abc&utm_source=nl&utm_medium=email') + '&data=05%7C01';
  assert.equal(await untrackUrl(wrapped), 'https://shop.example/unsub?token=abc');
});

test('unwraps nested redirectors', async () => {
  const inner = 'https://click.example/r?url=' + encodeURIComponent('https://list.example/u/1');
  const outer = 'https://www.google.com/url?q=' + encodeURIComponent(inner);
  assert.equal(await untrackUrl(outer), 'https://list.example/u/1');
});

test('unwraps base64 destinations in the path', async () => {
  const b64 = Buffer.from('https://target.example/x?id=7&fbclid=zz').toString('base64url');
  assert.equal(await untrackUrl(`https://click.example.com/r/${b64}`), 'https://target.example/x?id=7');
});

test('unwraps raw destinations appended to the path', async () => {
  assert.equal(await untrackUrl('https://t.example/redirect/https://target.example/u?id=1'),
    'https://target.example/u?id=1');
});

test('leaves opaque trackers and plain links alone', async () => {
  for (const url of [
    'https://list-manage.example/track/click?u=abc123&id=def',
    'https://example.com/unsubscribe/9f8e7d6c5b4a39281706',
    'https://example.com/u?t=AbCdEfGhIjKlMnOpQrStUvWx'
  ]) {
    assert.equal(await embeddedTarget(url), null, url);
    assert.equal(await untrackUrl(url), url);
  }
});

test('keeps the exact encoding of untouched query parameters', () => {
  assert.equal(stripTrackingParams('https://e.example/u?t=a%2Fb%2Bc~d&utm_campaign=x'), 'https://e.example/u?t=a%2Fb%2Bc~d');
  assert.equal(stripTrackingParams('https://e.example/u?utm_source=x'), 'https://e.example/u');
  assert.equal(stripTrackingParams('https://e.example/u#utm_source=x'), 'https://e.example/u');
});

test('returns invalid input unchanged', async () => {
  assert.equal(await untrackUrl('not a url'), 'not a url');
});
