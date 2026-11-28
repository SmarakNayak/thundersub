/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Localized "unsubscribe" wording used to find embedded unsubscribe links in
// email bodies (HTML anchor text and plain text) when senders don't provide a
// List-Unsubscribe header. The header path (RFC 2369 / RFC 8058) is
// language-agnostic and does NOT use this list.
//
// Guidelines for adding terms:
//   * Patterns are matched case-insensitively against short anchor/link text,
//     so prefer the imperative/infinitive forms that appear on buttons and
//     links ("Afmelden", "Se désabonner") over full sentences.
//   * Keep each stem specific enough to avoid colliding with ordinary prose in
//     that language (e.g. require the verb in front of "de baja"/"tilaus").
//   * Sources for each language's wording are cited inline below.

// Term fragments grouped by language. Each entry is a raw regex source
// matched case-insensitively; a Unicode-aware left boundary is applied once
// to the whole alternation below, so individual entries omit boundaries.
export const UNSUB_TERMS_BY_LANG = {
  // English — unsubscribe / unsubscribing / unsubscription. The right
  // boundary rejects letter suffixes only ('i' flag covers capitals): word
  // inflections flip or dilute intent ("you are now unsubscribed" is
  // confirmation-email wording; spam filler text uses "unsubscribes" /
  // "unsubscribers"), while non-letter suffixes appear in genuine
  // unsubscribe URLs ("/unsubscribe_ask/", which \b would reject because it
  // counts the underscore as a word character).
  en: [String.raw`un\W?subscri(?:be|bing|ption)(?![a-z])`],

  // Dutch — afmelden/afmelding/afmeldlink, split "af te melden",
  // uitschrijven/uitschrijving/uitschrijflink, "uit te schrijven",
  // "schrijf je/u uit", "meld je/u af", "abonnement/nieuwsbrief opzeggen".
  // "Opzeggen" needs the subscription context: bare it means cancelling
  // anything (contracts, insurance), and Dutch footers use afmelden/
  // uitschrijven for plain mailing lists. Sources:
  //   https://www.seniorweb.nl/artikel/afmelden-voor-reclamemails-en-nieuwsbrieven
  //   https://www.kvk.nl/veilig-zakendoen/durf-je-op-afmelden-te-klikken-in-een-nieuwsbrief/
  //   https://support.google.com/mail/answer/15433283?hl=nl
  nl: [
    String.raw`afmeld(?:en|ing|link)`,
    String.raw`af\s+te\s+melden`,
    String.raw`uitschrij(?:ven|ving|flink)`,
    String.raw`uit\s+te\s+schrijven`,
    String.raw`schrijf\s+(?:je|u)\s+uit`,
    String.raw`meld\s+(?:je|u)\s+af`,
    String.raw`(?:abonnement|nieuwsbrief)\s+opzeggen`
  ],

  // German — abmelden/Abmeldung/Abmeldelink, abbestellen/Abbestellung,
  // austragen. Source:
  //   https://context.reverso.net/translation/english-german/unsubscribe
  de: [
    String.raw`abmeld(?:en|ung|elink)`,
    String.raw`abbestell(?:en|ung)`,
    String.raw`austragen`
  ],

  // French — (se) désabonner / désabonnement / désabonnez, désinscrire /
  // désinscription / désinscrivez (accent optional). Source:
  //   https://context.reverso.net/translation/english-french/unsubscribe
  fr: [
    String.raw`d[eé]sabonn(?:er|ement|ez|és?)`,
    String.raw`d[eé]sinscri(?:re|ption|vez)`
  ],

  // Spanish — darse/darte/darme de baja, date de baja, cancelar/anular (la)
  // suscripción, desuscribir(se). Source:
  //   https://www.suped.com/knowledge/email-deliverability/compliance/what-is-the-correct-spanish-translation-for-unsubscribe-in-email-marketing
  es: [
    String.raw`dar(?:se|te|me)\s+de\s+baja`,
    String.raw`date\s+de\s+baja`,
    String.raw`(?:cancelar|anular)\s+(?:la\s+)?suscripci[óo]n`,
    String.raw`desuscribir(?:se|te)?`
  ],

  // Italian — annulla(re) (l')iscrizione, cancella(re) (l')iscrizione,
  // disiscriviti / disiscriversi / disiscrizione.
  it: [
    String.raw`(?:annulla|cancella)(?:re)?\s+(?:l['’]\s*)?iscrizione`,
    String.raw`disiscriv(?:iti|ersi)`,
    String.raw`disiscrizione`
  ],

  // Portuguese — cancelar (a) subscrição / inscrição / o envio, descadastrar,
  // desinscrever.
  pt: [
    String.raw`cancelar\s+(?:a\s+)?(?:subscri[çc][ãa]o|inscri[çc][ãa]o)`,
    String.raw`cancelar\s+o\s+envio`,
    String.raw`descadastr(?:ar|amento)`,
    String.raw`desinscrever`
  ],

  // Polish — "wypisz/wypisać się", "anuluj/anulować subskrypcję",
  // "zrezygnuj z subskrypcji", "rezygnacja z subskrypcji".
  pl: [
    String.raw`wypis(?:z|ać)\s+się`,
    String.raw`anul(?:uj|ować)\s+subskrypcj[ęe]`,
    String.raw`zrezygnuj\s+z\s+subskrypcji`,
    String.raw`rezygnacj[ai]\s+z\s+subskrypcji`
  ],

  // Swedish — avregistrera (dig), avprenumerera, avsluta prenumeration,
  // säg upp prenumeration. (Norwegian "avregistrer" is covered by the
  // shared prefix.)
  sv: [
    String.raw`avregistrer`,
    String.raw`avprenumerera`,
    String.raw`avsluta\s+prenumeration`,
    String.raw`säg\s+upp\s+prenumeration`
  ],

  // Danish — afmeld / afmelding (dig nyhedsbrevet), frameld.
  da: [
    String.raw`afmeld(?:ing)?`,
    String.raw`frameld`
  ],

  // Norwegian — "meld deg av", "meld av", avmeld(ing), avregistrer.
  nb: [
    String.raw`meld\s+deg\s+av`,
    String.raw`meld\s+av`,
    String.raw`avmeld(?:ing)?`,
    String.raw`avregistrer`
  ],

  // Finnish — "peru(uta) (uutiskirjeen) tilaus", "lopeta tilaus",
  // "poistu postituslistalta".
  fi: [
    String.raw`peru(?:uta)?\s+(?:uutiskirjeen\s+)?tilaus`,
    String.raw`lopeta\s+tilaus`,
    String.raw`poistu\s+postituslistalta`
  ],

  // Russian — отписаться/отписка, "отказаться от рассылки",
  // "отменить/отмена подписк(и)". Cyrillic relies on the Unicode boundary
  // below; ASCII \b would never match here.
  ru: [
    String.raw`отпис(?:аться|ка)`,
    String.raw`отказаться\s+от\s+рассылки`,
    String.raw`отмен(?:ить|а)\s+подписк`
  ]
};

const UNSUB_TERMS = Object.values(UNSUB_TERMS_BY_LANG).flat();

// A Unicode-aware left boundary: only match when not preceded by a letter,
// number, or underscore. ASCII \b cannot be used because it never sees a
// boundary next to accented (się, désabonnement) or non-Latin (отписаться)
// letters. No shared right boundary is applied: most terms are stems whose
// inflected suffixes should match (подписку, avregistrera, afmelding). A term
// can opt into its own right boundary where a suffix flips the meaning, as
// English does above to exclude "unsubscribed".
// Requires the 'u' flag, which callers must preserve when recompiling.
export const UNSUB_REGEX = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])(?:` + UNSUB_TERMS.join('|') + `)`,
  'iu'
);

// Named entities for the non-ASCII letters and separators that appear in the
// terms above ("d&eacute;sabonner", "darse&nbsp;de&nbsp;baja"). Numeric
// references (&#281;, &#x119;) are decoded generically, so only names need
// listing here.
const NAMED_ENTITIES = {
  nbsp: ' ',
  rsquo: '’',
  eacute: 'é',
  oacute: 'ó',
  ccedil: 'ç',
  atilde: 'ã',
  auml: 'ä'
};

function fromCodePointSafe(code, original) {
  return code <= 0x10ffff ? String.fromCodePoint(code) : original;
}

// Cheap prefilter over a raw (still entity-encoded) HTML or text body: false
// guarantees that no text node in the parsed document can match UNSUB_REGEX,
// letting callers skip DOM parsing entirely. A false positive only costs the
// caller the DOM parse it would have done anyway.
export function mayContainUnsubWording(body) {
  const text = String(body || '');
  if (UNSUB_REGEX.test(text)) return true;
  if (!text.includes('&')) return false;
  const decoded = text
    .replace(/&#(\d{1,7});/g, (entity, dec) => fromCodePointSafe(Number(dec), entity))
    .replace(/&#x([0-9a-f]{1,6});/gi, (entity, hex) => fromCodePointSafe(parseInt(hex, 16), entity))
    .replace(/&([a-z]+);/gi, (entity, name) => NAMED_ENTITIES[name.toLowerCase()] ?? entity);
  return UNSUB_REGEX.test(decoded);
}

// ── Links near unsubscribe wording ──────────────────────────────────────────
//
// Without a List-Unsubscribe header the link has to come from the body. A
// link whose own text is unsubscribe wording is taken as is. Near such
// wording in running text, though, transactional mail holds all kinds of
// links (order mails mention "Abmeldung" in their privacy notes next to a
// help page or the EU dispute-resolution link), so a nearby link only counts
// when it looks like an unsubscribe link itself or merely points ("click
// here") from the same sentence.

// Words in a URL that mark unsubscribe or mail-settings pages.
const UNSUB_HREF_REGEX = new RegExp(
  String.raw`unsub|opt[-_]?out|abmeld|abbestell|austrag|afmeld|d[eé]sabonn|d[eé]sinscri|baja|disiscri|` +
  String.raw`preferenc|praeferenz|präferenz|subscription|e-?mail[-_]?settings|e-?mail-?einstellungen|` +
  String.raw`notification|benachrichtigung|mailing[-_]?list`,
  'i'
);

function decodeHref(href) {
  let text = String(href || '');
  for (let i = 0; i < 2; i++) {
    try {
      const next = decodeURIComponent(text);
      if (next === text) break;
      text = next;
    } catch (e) {
      break;
    }
  }
  return text;
}

// Also finds the words inside the destination of a click-tracking link that
// carries it percent-encoded (awstrack.me/L0/https:%2F%2F…%2Funsubscribe…).
export function looksLikeUnsubHref(href) {
  const text = decodeHref(href).slice(0, 2000);
  return UNSUB_HREF_REGEX.test(text) || UNSUB_REGEX.test(text);
}

// Link texts that only point: "Um sich abzumelden, klicken Sie hier."
const POINTER_TEXTS = new Set([
  'here', 'click here', 'this link', 'link',
  'hier', 'hier klicken', 'klicken sie hier', 'klick hier', 'diesen link',
  'klik hier', 'deze link', 'ici', 'cliquez ici', 'ce lien',
  'aquí', 'aqui', 'haga clic aquí', 'haz clic aquí', 'este enlace',
  'qui', 'clicca qui', 'questo link', 'clique aqui', 'este link',
  'tutaj', 'kliknij tutaj', 'tu', 'här', 'klicka här', 'her', 'klik her', 'klikk her',
  'tästä', 'здесь', 'тут'
]);

export function isPointerText(text) {
  const normalized = String(text || '').slice(0, 100).toLowerCase()
    .replace(/[\s ]+/g, ' ')
    .replace(/^[\s.,:;!?"'«»„“”()[\]>→»›-]+|[\s.,:;!?"'«»„“”()[\]<←«‹-]+$/g, '');
  return POINTER_TEXTS.has(normalized);
}

// How far a plain URL may follow the wording ("Abmelden: https://…") when the
// URL itself says nothing about unsubscribing, and how far any URL may be.
const FOLLOWING_URL_MAX_GAP = 120;
const NEARBY_URL_MAX_DISTANCE = 300;
const TEXT_URL_REGEX = /https?:\/\/[^\s"'<>]{1,1000}/g;

// Plain-text bodies: the closest URL that looks like an unsubscribe link, or
// one that directly follows the wording.
export function findUnsubUrlInText(text) {
  const body = String(text || '');
  const wordings = [...body.matchAll(new RegExp(UNSUB_REGEX.source, 'giu'))];
  if (wordings.length === 0) return null;
  const urls = [...body.matchAll(TEXT_URL_REGEX)];

  let best = null;
  let bestDistance = NEARBY_URL_MAX_DISTANCE;
  for (const wording of wordings) {
    const wordingEnd = wording.index + wording[0].length;
    for (const url of urls) {
      const distance = Math.abs(wording.index - url.index);
      if (distance >= bestDistance) continue;
      // Same sentence only: "Abmeldung per Mail an uns). Streitbeilegung: http://ec.europa.eu/odr" is not one.
      const follows = url.index >= wordingEnd && url.index - wordingEnd <= FOLLOWING_URL_MAX_GAP &&
        !/[.!?)]\s|\n\s*\n/.test(body.slice(wordingEnd, url.index));
      if (follows || looksLikeUnsubHref(url[0])) {
        best = url[0];
        bestDistance = distance;
      }
    }
  }
  return best;
}
