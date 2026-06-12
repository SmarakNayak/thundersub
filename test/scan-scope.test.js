import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSenderSkipMatcher, isValidSenderPattern } from '../scan-scope.js';

test('returns null when there is nothing to match', () => {
  assert.equal(buildSenderSkipMatcher([]), null);
  assert.equal(buildSenderSkipMatcher(null), null);
  assert.equal(buildSenderSkipMatcher(['', '   ', 'not-a-pattern']), null);
});

test('matches exact addresses case-insensitively', () => {
  const skips = buildSenderSkipMatcher(['phish@spammer1.com']);
  assert.ok(skips('phish@spammer1.com'));
  assert.ok(skips('Phish@Spammer1.com'));
  assert.ok(!skips('other@spammer1.com'));
  assert.ok(!skips('phish@spammer1.com.evil.net'));
});

test('matches whole domains via *@ and bare @ wildcards', () => {
  const skips = buildSenderSkipMatcher(['*@spammer2.com', '@spammer3.com']);
  assert.ok(skips('anyone@spammer2.com'));
  assert.ok(skips('ANYONE@SPAMMER2.COM'));
  assert.ok(skips('x@spammer3.com'));
  assert.ok(!skips('anyone@notspammer2.com'));
  assert.ok(!skips('anyone@sub.spammer2.com'), 'subdomains are not implied');
});

test('a bare domain matches the domain and all its subdomains', () => {
  const skips = buildSenderSkipMatcher(['spammer.com']);
  assert.ok(skips('news@spammer.com'));
  assert.ok(skips('news@mail.spammer.com'));
  assert.ok(skips('news@a.b.spammer.com'));
  assert.ok(skips('NEWS@MAIL.SPAMMER.COM'));
  assert.ok(!skips('news@notspammer.com'));
  assert.ok(!skips('news@evilspammer.com'), 'label boundary is respected');
  assert.ok(!skips('news@spammer.com.evil.net'));
});

test('*@*.domain matches subdomains only', () => {
  const skips = buildSenderSkipMatcher(['*@*.spammer.com']);
  assert.ok(!skips('news@spammer.com'), 'the bare domain is not included');
  assert.ok(skips('news@mail.spammer.com'));
  assert.ok(skips('news@a.b.spammer.com'));
  assert.ok(!skips('news@notspammer.com'));
});

test('mixed exact and domain patterns work together', () => {
  const skips = buildSenderSkipMatcher(['phish@spammer1.com', '*@spammer2.com']);
  assert.ok(skips('phish@spammer1.com'));
  assert.ok(skips('news@spammer2.com'));
  assert.ok(!skips('news@spammer1.com'));
});

test('validates the pattern shapes the UI accepts', () => {
  for (const ok of ['phish@spammer.com', '*@spammer.com', '@spammer.com', 'a.b+c@d.co',
                    '*@*.spammer.com', '@*.spammer.com', 'spammer.com', 'mail.spammer.co.uk']) {
    assert.ok(isValidSenderPattern(ok), `expected valid: ${ok}`);
  }
  for (const bad of ['spammer', '*spammer.com', '*.spammer.com', 'a b@c.com', 'a@b@c',
                     'a@*.com', '*@*.', '']) {
    assert.ok(!isValidSenderPattern(bad), `expected invalid: ${bad}`);
  }
});
