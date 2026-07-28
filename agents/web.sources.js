// Wartbare Domain-Tier-Map. Aendert sich langsam, review halbjaehrlich.
// Regel: laengste Suffix-Uebereinstimmung gewinnt. Wildcard-Praefix "*." zaehlt
// wie normales Suffix. Unbekannte Domains -> Tier 3.
//
// Tier 1: Primaerquellen (Behoerden, Gesetze, Hersteller, offizielle Dokumente).
// Tier 2: hochwertige Sekundaerquellen (Fachpresse, wissenschaftl. Portale,
//         offizielle Supportseiten, Entwicklerblogs).
// Tier 3: Rest (Community, Foren, Blogs, Social Media, Ratgeberportale).
//
// Content-Tier-Regel greift zusaetzlich: PDF auf einer Tier-1-Domain bleibt
// Tier 1; PDF auf Tier-2-Domain wird nicht zu Tier 1 hochgestuft.

const TIER_1_SUFFIXES = [
  // DE Behoerden / Gesetzgebung / Regulierung
  'bund.de', 'bafin.de', 'bmf.bund.de', 'bmj.de', 'bmwk.de', 'bmg.bund.de',
  'bmas.de', 'bmuv.de', 'bmz.de', 'bmi.bund.de', 'bmvg.de', 'bmdv.bund.de',
  'bmbf.de', 'bundestag.de', 'bundesrat.de', 'bundesregierung.de',
  'gesetze-im-internet.de', 'bundesanzeiger.de',
  'destatis.de', 'bundesbank.de', 'bundesnetzagentur.de',
  'pei.de', 'rki.de', 'bfarm.de', 'dwd.de', 'kba.de',
  'kfw.de', 'bafa.de', 'zoll.de', 'arbeitsagentur.de',
  'deutsche-rentenversicherung.de', 'gkv-spitzenverband.de',
  'verbraucherzentrale.de',
  // EU / International
  'europa.eu', 'europarl.europa.eu', 'eur-lex.europa.eu', 'ecb.europa.eu',
  'eiopa.europa.eu', 'esma.europa.eu', 'eba.europa.eu',
  'admin.ch', 'gv.at',
  // Standards / offizielle Dokumentationen
  'iso.org', 'din.de', 'ieee.org', 'ietf.org', 'w3.org',
];

const TIER_2_SUFFIXES = [
  // Etablierte deutsche Fach- und Nachrichtenmedien
  'tagesschau.de', 'zeit.de', 'sueddeutsche.de', 'faz.net', 'handelsblatt.com',
  'spiegel.de', 'welt.de', 'br.de', 'ndr.de', 'wdr.de', 'zdf.de', 'ard.de',
  'dpa.com', 'reuters.com', 'bloomberg.com',
  'heise.de', 'golem.de', 'c-t.de',
  'aerzteblatt.de', 'pharmazeutische-zeitung.de',
  'fachanwalt.de', 'anwalt.de', 'juris.de', 'beck.de', 'noerr.com',
  'morningstar.de', 'boersen-zeitung.de', 'finanzen.net', 'finanztip.de',
  // Wissenschaft / offizielle Repositorien
  'nature.com', 'science.org', 'nih.gov', 'who.int', 'cdc.gov',
  'arxiv.org', 'ncbi.nlm.nih.gov', 'pubmed.ncbi.nlm.nih.gov',
  // Entwickler-/Produkt-Referenzen (offizielle Docs sind ohnehin auf Hersteller-Domain)
  'mdn.io', 'developer.mozilla.org',
];

// Domains, die trotz Bekanntheit als Tier 3 gelten (Community / User-Content).
const TIER_3_KNOWN = [
  'reddit.com', 'stackoverflow.com', 'stackexchange.com', 'quora.com',
  'medium.com', 'youtube.com', 'youtu.be', 'x.com', 'twitter.com',
  'linkedin.com', 'facebook.com', 'instagram.com', 'tiktok.com',
  'wikipedia.org', 'wikimedia.org', // solide, aber Sekundaer/User-editiert -> nie Primaer
  'gutefrage.net', 'chip.de', 'computerbild.de',
];

function hostnameOf(u) {
  try { return new URL(u).hostname.toLowerCase(); } catch { return ''; }
}

function matchesSuffix(host, list) {
  for (const s of list) {
    if (host === s || host.endsWith('.' + s)) return true;
  }
  return false;
}

// Liefert 1|2|3 fuer eine URL.
export function tierOf(url) {
  const host = hostnameOf(url);
  if (!host) return 3;
  if (matchesSuffix(host, TIER_3_KNOWN)) return 3;
  if (matchesSuffix(host, TIER_1_SUFFIXES)) return 1;
  if (matchesSuffix(host, TIER_2_SUFFIXES)) return 2;
  // Heuristik: .gov / .gov.* / .europa.eu-Subdomains -> Tier 1
  if (/(^|\.)gov(\.|$)/.test(host)) return 1;
  return 3;
}

// Hersteller-Boost war bis 2026-07-28 hier: query.includes(sld) hat systematisch
// falsche Tier-1-Zuweisungen produziert (z.B. Query "reddit test" -> reddit.com
// Tier 1). Regel: falsche Tier-1-Quellen sind schlimmer als fehlende. Der Boost
// wurde entfernt; effectiveTier ist jetzt ein duenner Wrapper um tierOf und
// bleibt aus Signatur-Kompatibilitaet erhalten.
export function effectiveTier(url, _opts = {}) {
  return tierOf(url);
}
