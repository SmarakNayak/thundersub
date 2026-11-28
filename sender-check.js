/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Does the unsubscribe link belong to the sender? Phishing and spam that
// imitate a brand put the brand in the From line but point the link at their
// own domain (From: …@bigstore.de, link: an unrelated domain). Real newsletters
// link to their own domain once click-tracking is unwrapped, or to a known
// sending service whose links say nothing about the destination.
//
// The From line alone proves nothing, so the check also reads the receiving
// server's Authentication-Results header: a DMARC pass or a DKIM signature by
// the From domain means the sender is who it claims to be. A link to a
// foreign domain from a sender that is not verified is the case where
// marking as junk beats unsubscribing.

// Public suffixes with more than one label that are common in mail. Not the
// full Public Suffix List: for an unlisted suffix the last two labels count
// as the registrable domain, which can only make two hosts look *different*,
// never wrongly the same.
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk',
  'co.at', 'or.at', 'gv.at', 'ac.at',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.nz', 'org.nz', 'net.nz',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'co.kr', 'or.kr',
  'com.cn', 'net.cn', 'org.cn', 'com.hk', 'com.tw', 'com.sg', 'com.my',
  'co.in', 'net.in', 'org.in', 'co.id', 'co.th', 'com.ph', 'com.vn',
  'co.za', 'org.za', 'co.il', 'org.il',
  'com.br', 'net.br', 'org.br', 'com.mx', 'com.ar', 'com.co', 'com.pe',
  'com.tr', 'com.ua', 'com.pl', 'com.cy', 'com.mt'
]);

// Sending services whose unsubscribe and click links stay opaque: the link
// goes to the service, not to the sender, and does not reveal where it ends
// up. Not suspicious by itself.
const SENDING_SERVICES = new Map(Object.entries({
  'sendgrid.net': 'SendGrid',
  'exct.net': 'Salesforce Marketing Cloud', 'exacttarget.com': 'Salesforce Marketing Cloud',
  'salesforce.com': 'Salesforce Marketing Cloud',
  'salesmanago.com': 'SALESmanago', 'salesmanago.pl': 'SALESmanago',
  'hubspotemail.net': 'HubSpot', 'hubspotlinks.com': 'HubSpot', 'hubspotstarter.net': 'HubSpot',
  'hs-sites.com': 'HubSpot', 'hubspot.com': 'HubSpot',
  'mailgun.org': 'Mailgun', 'mailgun.net': 'Mailgun',
  'list-manage.com': 'Mailchimp', 'mailchimp.com': 'Mailchimp', 'mcsv.net': 'Mailchimp',
  'rsgsv.net': 'Mailchimp', 'mailchi.mp': 'Mailchimp', 'mandrillapp.com': 'Mailchimp',
  'sendinblue.com': 'Brevo', 'brevo.com': 'Brevo', 'sp1-brevo.net': 'Brevo',
  'sendibt2.com': 'Brevo', 'sendibt3.com': 'Brevo', 'sendibm1.com': 'Brevo',
  'klaviyo.com': 'Klaviyo', 'klaviyomail.com': 'Klaviyo', 'klclick.com': 'Klaviyo',
  'klclick1.com': 'Klaviyo', 'klclick2.com': 'Klaviyo', 'klclick3.com': 'Klaviyo',
  'createsend.com': 'Campaign Monitor', 'createsend1.com': 'Campaign Monitor',
  'cmail19.com': 'Campaign Monitor', 'cmail20.com': 'Campaign Monitor',
  'emarsys.net': 'Emarsys', 'emarsys.com': 'Emarsys',
  'cleverreach.com': 'CleverReach', 'newsletter2go.com': 'Newsletter2Go',
  'mailjet.com': 'Mailjet', 'mjt.lu': 'Mailjet',
  'constantcontact.com': 'Constant Contact', 'rs6.net': 'Constant Contact',
  'getresponse.com': 'GetResponse', 'aweber.com': 'AWeber',
  'activehosted.com': 'ActiveCampaign', 'acemlna.com': 'ActiveCampaign', 'acemlnb.com': 'ActiveCampaign',
  'mktomail.com': 'Marketo', 'marketo.com': 'Marketo', 'mktoweb.com': 'Marketo',
  'eloqua.com': 'Oracle Eloqua', 'en25.com': 'Oracle Eloqua',
  'responsys.net': 'Oracle Responsys', 'sailthru.com': 'Sailthru',
  'customeriomail.com': 'Customer.io', 'customer.io': 'Customer.io',
  'iterable.com': 'Iterable', 'moengage.com': 'MoEngage', 'braze.com': 'Braze', 'braze.eu': 'Braze',
  'substack.com': 'Substack', 'beehiiv.com': 'beehiiv', 'mailerlite.com': 'MailerLite',
  'mlsend.com': 'MailerLite', 'convertkit-mail.com': 'Kit', 'ck.page': 'Kit',
  'sparkpostmail.com': 'SparkPost', 'amazonses.com': 'Amazon SES', 'awstrack.me': 'Amazon SES',
  'srv2.de': 'Optimizely Campaign', 'evalanche.com': 'Evalanche', 'inxmail.com': 'Inxmail',
  'inxserver.com': 'Inxmail', 'rapidmail.de': 'rapidmail', 'mapp.com': 'Mapp',
  'ecm-cluster.com': 'Mapp', 'teradatadmc.com': 'Mapp',
  'spmta.com': 'Acoustic', 'kmail-lists.com': 'Klaviyo', 'newslettertogo.com': 'Newsletter2Go',
  'bmetrack.com': 'Benchmark Email', 'benchurl.com': 'Benchmark Email', 'xcampaign.ch': 'XCampaign',
  'bluehornet.com': 'BlueHornet', 'sparkpost.com': 'SparkPost', 'mailgun.com': 'Mailgun',
  'elasticemail.net': 'Elastic Email', 'elasticemail.com': 'Elastic Email', 'mailbluster.com': 'MailBluster',
  'enginemailer.org': 'EngineMailer', 'autopilotmail.io': 'Autopilot', 'loops.so': 'Loops',
  'synerise.com': 'Synerise', 'smtp.com': 'SMTP.com', 'maillist-manage.eu': 'Zoho Campaigns',
  'maillist-manage.com': 'Zoho Campaigns', 'parcellab.com': 'parcelLab', 'bazaarvoice.com': 'Bazaarvoice',
  'qualtrics.com': 'Qualtrics', 'qemailserver.com': 'Qualtrics', 'medallia.eu': 'Medallia', 'medallia.com': 'Medallia'
}));
const SENDING_SERVICE_PATTERNS = [[/^mkt\d+\.com$/, 'Acoustic'], [/^acems[a-z]*\d*\.com$/, 'ActiveCampaign']];

// Free mail providers. Anyone can open an account there, so a valid
// signature from one says nothing about who is behind the mail; real
// newsletters are not sent from them. onmicrosoft.com are Microsoft 365
// trial tenants, a favourite of phishers.
const FREEMAIL_DOMAINS = new Set([
  'gmx.de', 'gmx.net', 'gmx.com', 'gmx.at', 'gmx.ch', 'gmx.biz', 'web.de', 't-online.de',
  'freenet.de', 'arcor.de', 'mail.de', 'posteo.de', 'gmail.com', 'googlemail.com',
  'hotmail.com', 'hotmail.de', 'outlook.com', 'outlook.de', 'live.com', 'live.de', 'msn.com',
  'onmicrosoft.com', 'yahoo.com', 'yahoo.de', 'aol.com', 'aol.de', 'icloud.com', 'me.com',
  'mail.com', 'email.ua', 'ukr.net', 'mail.ru', 'yandex.ru', 'yandex.com', 'proton.me',
  'protonmail.com', 'zoho.com', 'gmx.us'
]);

// Header values come from the mail. Real Authentication-Results headers are
// a few hundred bytes, one per signature at most; anything far beyond that
// is cut off instead of parsed.
const MAX_AUTH_HEADERS = 16;
const MAX_HEADER_CHARS = 4096;
const MAX_NAME_CHARS = 200;

function normalizeHost(host) {
  return String(host || '').trim().toLowerCase().replace(/\.$/, '');
}

export function registrableDomain(host) {
  const name = normalizeHost(host);
  if (!name || /^[\d.]+$/.test(name) || name.includes(':')) return name; // IP address
  const labels = name.split('.');
  if (labels.length <= 2) return name;
  const lastTwo = labels.slice(-2).join('.');
  return labels.slice(MULTI_LABEL_SUFFIXES.has(lastTwo) ? -3 : -2).join('.');
}

function domainOfAddress(address) {
  const at = String(address || '').lastIndexOf('@');
  return at < 0 ? '' : normalizeHost(address.slice(at + 1));
}

// Host an unsubscribe method contacts: the web host, or the domain a
// mailto: unsubscribe mail goes to.
export function targetHost(url) {
  const text = String(url || '').trim();
  if (/^mailto:/i.test(text)) {
    let address = text.slice(7).split('?')[0];
    try { address = decodeURIComponent(address); } catch (e) { /* keep raw */ }
    return domainOfAddress(address.split(',')[0]);
  }
  try {
    return normalizeHost(new URL(text).hostname);
  } catch (e) {
    return '';
  }
}

export function sendingService(host) {
  const domain = registrableDomain(host);
  if (SENDING_SERVICES.has(domain)) return SENDING_SERVICES.get(domain);
  const pattern = SENDING_SERVICE_PATTERNS.find(([re]) => re.test(domain));
  return pattern ? pattern[1] : null;
}

export function isFreemail(address) {
  return FREEMAIL_DOMAINS.has(registrableDomain(domainOfAddress(address)));
}

// The domain without its public suffix: 'airbnb' for airbnb.de.
function brandLabel(domain) {
  const labels = registrableDomain(domain).split('.');
  return labels.length > 1 ? labels.slice(0, -1).join('.').split('.')[0] : labels[0];
}

// airbnb.com and airbnb.de, trustpilotmail.com and trustpilot.com: one
// brand on two registrable domains.
function sameBrand(a, b) {
  const x = brandLabel(a);
  const y = brandLabel(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length < y.length ? [x, y] : [y, x];
  return short.length >= 5 && long.includes(short);
}

// Words in display names that name no one.
const GENERIC_NAME_WORDS = new Set([
  'com', 'net', 'org', 'www', 'info', 'team', 'the', 'and', 'von', 'der', 'die', 'das', 'und', 'for',
  'from', 'your', 'ihr', 'mail', 'email', 'news', 'newsletter', 'service', 'support', 'kundenservice',
  'customer', 'noreply', 'reply', 'official', 'offiziell', 'vip', 'premium'
]);

// Does the display name fit the address? Phishing borrows a brand for the
// name ("Big Store VIP") but sends from wherever it got access
// (admk.hijacked-store.de). For company domains a name word has to appear in the
// domain; on a free mail provider in the part before the @, as with
// "Erika Muster" <erika.muster@gmx.net>. true: it fits; false: no name
// word appears; null: no usable name.
export function nameMatchesSender(senderName, senderEmail) {
  const address = String(senderEmail || '').toLowerCase();
  const at = address.lastIndexOf('@');
  if (at < 0) return null;
  const part = isFreemail(address) ? address.slice(0, at) : address.slice(at + 1);
  const haystack = part.replace(/[^a-z0-9]/g, '');
  let name = String(senderName || '').slice(0, MAX_NAME_CHARS).toLowerCase();
  // "B i g S t o r e": letters spaced out to dodge filters.
  if (/^(?:\S\s)+\S$/.test(name.trim())) name = name.replace(/\s+/g, '');
  // Domains spell umlauts either way: "Möbel Köhler" is koehler.de, "Müller" may be mueller.de or muller.com.
  const spellings = [name.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss'), name];
  const wordsOf = (text) => text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !GENERIC_NAME_WORDS.has(w));
  const words = spellings.flatMap(wordsOf);
  if (!haystack || words.length === 0 || name.includes('@')) return null;
  return words.some(w => haystack.includes(w));
}

// ── Authentication-Results (RFC 8601) ────────────────────────────────────────

function stripComments(text) {
  let out = '';
  let depth = 0;
  let quoted = false;
  for (const ch of String(text || '')) {
    if (quoted) {
      out += ch;
      if (ch === '"') quoted = false;
    } else if (ch === '"' && depth === 0) {
      quoted = true;
      out += ch;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')' && depth > 0) {
      depth--;
    } else if (depth === 0) {
      out += ch;
    }
  }
  return out;
}

export function parseAuthResults(value) {
  const parts = stripComments(String(value ?? '').slice(0, MAX_HEADER_CHARS)).replace(/\s*=\s*/g, '=').split(';');
  const authservId = normalizeHost(parts.shift().trim().split(/\s+/)[0]);
  const results = [];
  for (const part of parts) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    const head = /^([\w-]+)=([\w-]+)$/.exec(tokens.shift() || '');
    if (!head) continue;
    const props = {};
    for (const token of tokens) {
      const prop = /^([\w-]+\.[\w-]+)=(.*)$/.exec(token);
      if (prop) props[prop[1].toLowerCase()] = prop[2].replace(/^"(.*)"$/, '$1');
    }
    results.push({ method: head[1].toLowerCase(), result: head[2].toLowerCase(), props });
  }
  return { authservId, results };
}

function dkimDomain(props) {
  if (props['header.d']) return normalizeHost(props['header.d']);
  const identity = props['header.i'] || '';
  return identity.includes('@') ? domainOfAddress(identity) : normalizeHost(identity);
}

// Verdict for one message: 'pass' (DMARC pass, or DKIM signed by the From
// domain), 'fail' (DMARC or DKIM failed), 'third-party' (only signed by
// someone else, e.g. the sending service) or 'none' (no usable result).
//
// Trusted are the headers written by the receiving server: the topmost one
// (added last) and others carrying the same authserv-id (some providers
// write one per signature). RFC 8601 has the server delete incoming headers
// that claim its id; headers from any other id may have come with the
// message and are ignored, a forged "dkim=pass" is cheap.
export function messageAuthStatus(authResultsHeaders, fromAddress) {
  const headers = Array.isArray(authResultsHeaders) ? authResultsHeaders.slice(0, MAX_AUTH_HEADERS) : [];
  const parsed = headers.map(parseAuthResults);
  const fromDomain = registrableDomain(domainOfAddress(fromAddress));
  if (!parsed.length || !parsed[0].authservId || !fromDomain) return { status: 'none', signers: [] };
  const results = parsed.filter(p => p.authservId === parsed[0].authservId).flatMap(p => p.results);
  const aligned = (domain) => !!domain && registrableDomain(domain) === fromDomain;

  const signers = [];
  let failed = false;
  for (const { method, result, props } of results) {
    if (method === 'dmarc') {
      if (result === 'pass' && (!props['header.from'] || aligned(props['header.from']))) {
        return { status: 'pass', signers: [] };
      }
      if (result === 'fail') failed = true;
    } else if (method === 'dkim') {
      const domain = dkimDomain(props);
      if (result === 'pass') {
        if (aligned(domain)) return { status: 'pass', signers: [] };
        if (domain && !signers.includes(domain)) signers.push(domain);
      } else if (result === 'fail' || result === 'permerror') {
        failed = true;
      }
    }
  }
  if (failed) return { status: 'fail', signers };
  return { status: signers.length ? 'third-party' : 'none', signers };
}

// Running tally per subscription; latest is the newest message's verdict.
export function emptySenderAuth() {
  return { pass: 0, fail: 0, 'third-party': 0, none: 0, latest: null, latestDate: '', signers: [] };
}

export function addSenderAuth(tally, { status, signers }, date = '') {
  tally[status] = (tally[status] || 0) + 1;
  if (!tally.latest || String(date) > String(tally.latestDate)) {
    tally.latest = status;
    tally.latestDate = String(date || '');
  }
  for (const signer of signers || []) {
    if (tally.signers.length < 3 && !tally.signers.includes(signer)) tally.signers.push(signer);
  }
  return tally;
}

// ── Verdict for the unsubscribe dialog ───────────────────────────────────────

// Which of the given addresses appears in the link, plain or percent-encoded
// (also twice, as redirectors do). Base64 or IDs are not found; for a
// passer-by they are as opaque as intended.
export function addressInLink(url, addresses = []) {
  let text = String(url || '').toLowerCase();
  for (let i = 0; i < 2; i++) {
    try { text = decodeURIComponent(text); } catch (e) { break; }
  }
  return addresses
    .map(address => String(address || '').trim().toLowerCase())
    .find(address => address.includes('@') && text.includes(address)) || null;
}

// relation: 'same' (link on the sender's domain or a sister domain of the
// same brand), 'service' (opaque sending service), 'foreign' (some other
// domain) or 'unknown' (no host).
// verified: true (newest mail passed), false (its signature failed or is
// someone else's) or null (no result: old mail, a provider that writes no
// Authentication-Results, or a scan from before this check). Only true and
// false are evidence; plenty of genuine mail from before 2022 has no result.
// insecure: plain http://, so the whole link travels unencrypted and anyone
// on the network path can read it; addressInLink: the recipient address
// found in it, if any.
// junkReasons: why the mail looks like spam rather than a newsletter
// ('failed' signature, 'unverified' sender, 'freemail', 'name').
// Empty for links on the sender's own domain: unsubscribing there only
// reaches whoever owns the domain the mail claims to come from.
// listUnsubscribe: whether the sender uses the List-Unsubscribe header
// (undefined: not known).
export function checkUnsubTarget({ url, senderEmail, senderName, senderAuth, recipientAddresses = [], listUnsubscribe }) {
  const host = targetHost(url);
  const senderDomain = registrableDomain(domainOfAddress(senderEmail));
  const linkDomain = registrableDomain(host);
  const service = host ? sendingService(host) : null;

  let relation = 'unknown';
  if (host && senderDomain) {
    if (linkDomain === senderDomain || sameBrand(linkDomain, senderDomain)) relation = 'same';
    else if (service) relation = 'service';
    else relation = 'foreign';
  }

  const authStatus = senderAuth?.latest || null;
  const verified = authStatus === 'pass' ? true
    : authStatus === 'fail' || authStatus === 'third-party' ? false : null;
  const freemail = isFreemail(senderEmail);
  const nameMatch = nameMatchesSender(senderName, senderEmail);
  const junkReasons = [];
  if (relation === 'foreign') {
    if (authStatus === 'fail') junkReasons.push('failed');
    else if (verified === false) junkReasons.push('unverified');
    // A free mail account is fine for a person, not for a company.
    if (freemail && nameMatch !== true) junkReasons.push('freemail');
    if (!freemail && nameMatch === false) junkReasons.push('name');
  } else if (relation === 'service') {
    // Anyone can send through a sending service (spam rides on Substack
    // too), so the link proves nothing. A signature by the service alone and
    // a display name unlike the domain are normal there; a failed signature
    // or free mail posing as a company are not.
    if (authStatus === 'fail') junkReasons.push('failed');
    if (freemail && nameMatch !== true) junkReasons.push('freemail');
    // Newsletters sent through a service carry the List-Unsubscribe header;
    // spam that only links to the service from the body and borrows a name
    // ("Antivirus-Warnungen" from a hijacked club domain) does not.
    if (!freemail && listUnsubscribe === false && nameMatch === false) junkReasons.push('name');
  }
  return {
    relation,
    linkDomain,
    senderDomain,
    service,
    verified,
    freemail,
    nameMatch,
    authStatus,
    insecure: /^http:\/\//i.test(String(url || '').trim()),
    addressInLink: addressInLink(url, recipientAddresses),
    signers: senderAuth?.signers || [],
    junkReasons,
    recommendJunk: junkReasons.length > 0
  };
}
