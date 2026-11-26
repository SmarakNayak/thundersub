/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Classifies the text of an unsubscribe landing page so ThunderSub can tell
// "you are unsubscribed" apart from "click Confirm to finish". Heuristic only:
// it reports how the page reads, not whether the sender really removed you.
//
//   'confirmed'  the page says the unsubscribe went through
//   'action'     the page wants a click or input from you
//   'failed'     the page says it cannot unsubscribe you, or reports an error
//   'unclear'    nothing recognisable (yet)

import { UNSUB_REGEX } from './unsub-detect.js';

// Past/perfect statements that the unsubscribe already happened.
const CONFIRMED_PATTERNS = [
  // Geo-blocked landing page some senders show after the unsubscribe request.
  /offer (?:is|are) not available in your (?:country|region)/i,
  // English
  /you(?:'|’)?(?:ve| have)(?: now| successfully| been)* (?:been )?(?:un\W?subscribed|removed|opted out)/i,
  /you (?:are|were) (?:now |successfully )?(?:un\W?subscribed|removed from)/i,
  /(?:successfully|been) un\W?subscribed/i,
  /already (?:been )?(?:un\W?subscribed|removed|opted out)/i,
  /un\W?subscri(?:be|ption) (?:was |is |has been )?(?:successful|confirmed|complete[d]?|processed)/i,
  // Dutch
  /je bent (?:nu )?(?:afgemeld|uitgeschreven)|u bent (?:nu )?(?:afgemeld|uitgeschreven)/i,
  // German
  /(?:sie |du )?(?:wurden|wurdest|sind|bist) (?:erfolgreich )?(?:abgemeldet|ausgetragen)|erfolgreich abgemeldet/i,
  // French
  /vous avez été (?:désabonné|désinscrit)|vous êtes (?:désormais )?(?:désabonné|désinscrit)|d[eé]sabonnement (?:a été |est )?(?:pris en compte|effectué|confirmé|réussi)/i,
  // Spanish
  /te has dado de baja|se ha dado de baja|has sido dado de baja|baja (?:realizada|confirmada|completada)|cancelaste tu suscripci[óo]n/i,
  // Italian
  /ti sei disiscritto|sei stato disiscritto|iscrizione (?:annullata|cancellata)|cancellazione completata/i,
  // Portuguese
  /você foi descadastrado|voc[eê] n[aã]o receber[aá] mais|cancelamento (?:realizado|conclu[ií]do)|descadastr(?:o|amento) (?:realizado|conclu[ií]do)/i,
  // Polish
  /wypisano|zosta[łl](?:e|a)ś wypisany|zosta[łl](?:e|a)ś wypisana/i,
  // Swedish / Danish / Norwegian / Finnish
  /du har avregistrerat|du har avslutat|du er (?:nu )?afmeldt|du er (?:nå )?avmeldt|tilaus on peruttu|olet poistunut/i,
  // Russian
  /вы (?:успешно )?отписались|вы (?:успешно )?отписаны|подписка отменена/i
];

// Future or descriptive wording. Forms often say "you will no longer receive
// our emails" or "removed from our list" ABOVE the box where you must still
// enter your address, so these only count when the page wants nothing more.
const WEAK_CONFIRMED_PATTERNS = [
  /(?:you|we)(?:'|’)?(?:ll| will)? (?:no longer|not) (?:receive|get|send)/i,
  /(?:you|we) (?:won(?:'|’)?t|will not) (?:receive|get|send) (?:any )?(?:more|further)/i,
  /removed (?:you )?from (?:our|the|this|these) (?:mailing )?lists?/i,
  /(?:email )?preferences (?:have been |were )?(?:updated|saved)/i
];

// The page says it cannot unsubscribe you (or something broke).
const FAILED_PATTERNS = [
  /no (?:un\W?subscri\w*|opt[- ]?out) (?:method|option|link|way)/i,
  /no (?:method|option|way) (?:available )?to un\W?subscribe/i,
  /un\W?subscri\w* (?:is |are )?(?:not available|unavailable|not possible|disabled)/i,
  /(?:can(?:'|’)?t|cannot|can not|unable to|couldn(?:'|’)?t|could not|failed to) (?:un\W?subscribe|process your (?:un\W?subscri\w*|request))/i,
  /something went wrong|an error (?:has )?occurred|link (?:has )?expired|invalid (?:link|request|token)|page (?:was )?not found|404/i
];

const ACTION_PATTERNS = [
  /confirm (?:your )?un\W?subscri/i,
  /click (?:the )?(?:button|here|below)[^.]{0,40}(?:confirm|un\W?subscribe)/i,
  /(?:to|please) (?:complete|finish|confirm)[^.]{0,40}un\W?subscri/i,
  /are you sure[^.]{0,60}un\W?subscri/i,
  /(?:enter|type|provide|confirm) your (?:e-?mail|address)/i,
  /(?:reason|why)[^.]{0,30}(?:leaving|un\W?subscrib)/i,
  /i(?:'|’)?m not a robot|captcha/i,
  /un\W?subscribe by (?:entering|typing|providing|submitting|clicking)/i,
  /(?:entering|typing|providing|submit(?:ting)?) your (?:e-?mail|address)/i,
  /(?:clicking|click|press|pressing|tap|tapping) (?:the )?(?:button )?["“'‘]?un\W?subscribe/i
];

export function classifyUnsubPageText(text, controlsText = '', hasTextInput = false) {
  const body = String(text || '').slice(0, 20000);
  const controls = String(controlsText || '').slice(0, 2000);
  if (CONFIRMED_PATTERNS.some(pattern => pattern.test(body))) return 'confirmed';
  if (FAILED_PATTERNS.some(pattern => pattern.test(body))) return 'failed';
  // A visible text/email box means the page still wants input from you, so
  // it outranks weak "you will no longer receive" wording.
  if (hasTextInput === true || ACTION_PATTERNS.some(pattern => pattern.test(body))) return 'action';
  if (WEAK_CONFIRMED_PATTERNS.some(pattern => pattern.test(body))) return 'confirmed';
  // A button or submit control that itself says "Unsubscribe" means the
  // page is waiting for a click.
  if (UNSUB_REGEX.test(controls)) return 'action';
  return 'unclear';
}
