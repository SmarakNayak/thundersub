import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { UNSUB_REGEX, UNSUB_TERMS_BY_LANG, mayContainUnsubWording } from '../unsub-detect.js';

const repoFile = (name) => new URL(`../${name}`, import.meta.url);

// Mirrors how background.js recompiles the pattern for plain-text bodies: a
// fresh global regex from the source. The 'u' flag must be preserved or the
// Unicode boundary / property escapes break.
function globalRegex() {
  return new RegExp(UNSUB_REGEX.source, 'giu');
}

// Real-world link/button text per language that MUST be detected.
const POSITIVE = {
  en: ['Unsubscribe', 'To unsubscribe click here', 'You can unsubscribe at any time',
       'manage your unsubscription',
       'https://subscription.example/mail/unsubscribe_ask/toEGGvbX6hRaTs'],
  nl: ['Afmelden', 'Afmelden voor deze nieuwsbrief', 'Klik hier om je af te melden',
       'Uitschrijven', 'om je uit te schrijven', 'Schrijf je uit', 'Meld u af',
       'Afmeldlink', 'abonnement opzeggen'],
  de: ['Abmelden', 'Vom Newsletter abmelden', 'Newsletter abbestellen', 'Abbestellung',
       'Hier austragen', 'Abmeldelink'],
  fr: ['Se désabonner', 'Gérer votre désabonnement', 'Cliquez ici pour vous désinscrire',
       'désinscription', 'Vous désabonnez ici', 'desabonnement'],
  es: ['Darse de baja', 'Date de baja aquí', 'Cancelar la suscripción',
       'anular suscripción', 'Desuscribirse'],
  it: ['Annulla iscrizione', "annullare l'iscrizione", 'annullare l’iscrizione',
       'Cancella iscrizione', 'Disiscriviti', 'disiscrizione'],
  pt: ['Cancelar subscrição', 'cancelar a inscrição', 'Cancelar o envio',
       'Descadastrar', 'descadastramento', 'Desinscrever'],
  pl: ['Wypisz się', 'Wypisać się z newslettera', 'Anuluj subskrypcję',
       'anulować subskrypcję', 'Zrezygnuj z subskrypcji', 'Rezygnacja z subskrypcji'],
  sv: ['Avregistrera', 'Avregistrera dig', 'Avprenumerera', 'Avsluta prenumeration',
       'Säg upp prenumeration'],
  da: ['Afmeld', 'Afmeld dig nyhedsbrevet', 'Afmelding', 'Frameld dig'],
  nb: ['Meld deg av', 'Meld av', 'Avmeld', 'Avmelding', 'Avregistrer deg'],
  fi: ['Peru tilaus', 'Peruuta tilaus', 'Peru uutiskirjeen tilaus', 'Lopeta tilaus',
       'Poistu postituslistalta'],
  ru: ['Отписаться', 'Отписаться от рассылки', 'отписка', 'Отказаться от рассылки',
       'Отменить подписку', 'ОТПИСАТЬСЯ']
};

// Ordinary text in the same languages that MUST NOT trigger a false positive.
const NEGATIVE = [
  'Subscribe to our newsletter',                 // en: opposite action
  'Your order has shipped',                       // en
  'You Are Now Unsubscribed',                     // en: confirmation, not a subscription
  'https://x.example/unsubscribed/4/me@example.com', // en: confirmation-page URL
  'willingness.unsubscribes.zh.grossen.spacey',   // en: spam hash-buster filler
  'station.secondary.unsubscribers.trout.robust', // en: spam hash-buster filler
  'Aanmelden voor de nieuwsbrief',                // nl: sign up
  'U kunt uw contract hier opzeggen',             // nl: contract, not a mailing list
  'Anmelden Sie sich jetzt an',                   // de: sign up / login
  'Inscrivez-vous à la newsletter',               // fr: sign up
  'baja temperatura esta semana',                 // es: "baja" unrelated
  'La inscripción ya está abierta',               // es: registration open
  'Completa la tua iscrizione',                   // it: complete your registration
  'Faça sua inscrição agora',                     // pt: register now
  'Zapisz się do newslettera',                    // pl: sign up
  'Registrera dig för nyhetsbrevet',              // sv: register (not avregistrera)
  'Tilaa uutiskirje',                             // fi: subscribe
  'Оформить подписку на рассылку',                // ru: subscribe (not отписаться)
  'Manage your account settings'                  // generic
];

test('every configured language has at least one positive sample', () => {
  for (const lang of Object.keys(UNSUB_TERMS_BY_LANG)) {
    assert.ok(POSITIVE[lang] && POSITIVE[lang].length > 0,
      `missing positive samples for language "${lang}"`);
  }
});

test('detects unsubscribe wording across languages', () => {
  for (const [lang, samples] of Object.entries(POSITIVE)) {
    for (const sample of samples) {
      assert.ok(UNSUB_REGEX.test(sample),
        `[${lang}] expected to match: ${JSON.stringify(sample)}`);
    }
  }
});

test('does not match ordinary or opposite-intent text', () => {
  for (const sample of NEGATIVE) {
    assert.ok(!UNSUB_REGEX.test(sample),
      `expected NOT to match: ${JSON.stringify(sample)}`);
  }
});

test('matches mid-sentence with surrounding punctuation and links', () => {
  const body = 'Bedankt voor uw bestelling.\nWilt u geen mail meer? (Afmelden) https://x.example/u';
  const m = globalRegex();
  const hits = [...body.matchAll(m)];
  assert.equal(hits.length, 1);
  assert.equal(hits[0][0].toLowerCase(), 'afmelden');
});

test('left boundary prevents matching inside a larger word', () => {
  // "resubscribe" / "presubscription" should not match the English stem, and a
  // Cyrillic stem glued to a preceding letter should not match either.
  assert.ok(!UNSUB_REGEX.test('xunsubscribe'));
  assert.ok(!UNSUB_REGEX.test('преотписаться'));
});

test('Cyrillic relies on Unicode case-insensitivity (no ASCII \\b)', () => {
  assert.ok(UNSUB_REGEX.test('ОТПИСАТЬСЯ'));
  assert.ok(UNSUB_REGEX.test(' отписаться '));
});

test('compiled regex uses the Unicode flag', () => {
  assert.ok(UNSUB_REGEX.flags.includes('u'));
  assert.ok(UNSUB_REGEX.flags.includes('i'));
  // The recompiled global form (as background.js builds it) must stay valid.
  assert.doesNotThrow(() => globalRegex());
});

test('prefilter passes literal unsubscribe wording in raw HTML', () => {
  assert.ok(mayContainUnsubWording('<p>Tired of these? <a href="https://x.example/u">Unsubscribe</a></p>'));
  assert.ok(mayContainUnsubWording('Klik hier om je af te melden'));
});

test('prefilter passes terms hidden behind HTML entity encoding', () => {
  assert.ok(mayContainUnsubWording('Se d&eacute;sabonner'),
    'named accent entity');
  assert.ok(mayContainUnsubWording('Darse&nbsp;de&nbsp;baja'),
    'non-breaking-space separator');
  assert.ok(mayContainUnsubWording('annullare l&rsquo;iscrizione'),
    'curly-apostrophe entity');
  assert.ok(mayContainUnsubWording('Wypisz si&#x119; z newslettera'),
    'hex numeric entity');
  assert.ok(mayContainUnsubWording('&#1054;&#1090;&#1087;&#1080;&#1089;&#1072;&#1090;&#1100;&#1089;&#1103;'),
    'decimal numeric entities (Отписаться)');
});

test('prefilter rejects ordinary mail bodies', () => {
  assert.ok(!mayContainUnsubWording(''));
  assert.ok(!mayContainUnsubWording('<p>Your order has shipped &amp; is on its way.</p>'));
  assert.ok(!mayContainUnsubWording('Re: Q3 budget &mdash; final figures attached'));
});

test('manifest uses the module-loading background page', () => {
  const manifest = JSON.parse(fs.readFileSync(repoFile('manifest.json'), 'utf8'));
  assert.equal(manifest.background.page, 'background.html');
  const page = fs.readFileSync(repoFile('background.html'), 'utf8');
  assert.match(page, /<script type="module" src="background\.js">/,
    'background.html must load background.js as an ES module');
});

test('build.sh bundles the background page and modules into the xpi', () => {
  const build = fs.readFileSync(repoFile('build.sh'), 'utf8');
  for (const f of ['background.html', 'unsub-detect.js', 'scan-scope.js', 'unsub-url.js',
                   'junk-routing.js', 'background.js']) {
    assert.ok(build.includes(f), `${f} missing from build.sh zip list`);
  }
});
