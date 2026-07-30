// Lokaler Runner fuer die Mail-Klassifikation.
//
// Modus 1 (Default, MOCK): laeuft ohne IMAP-Zugriff mit hartkodierten
//   realistischen Beispielmails. Braucht nur ANTHROPIC_API_KEY. Zweck: den
//   Klassifikations- und Ausgabe-Pfad lokal beweisen.
// Modus 2 (LIVE): setzt CLI-Flag --live. Ruft den Server-Endpoint
//   GET /api/mails/klassifiziert auf. Braucht laufenden Server + volles Env
//   (MAIL_*_USER/_PASS, ANTHROPIC_API_KEY, ggf. API_TOKEN).
//
// Aufruf:
//   cd iva-core
//   node --env-file=.env scripts/mail-klassifikation-runner.mjs           # MOCK
//   node --env-file=.env scripts/mail-klassifikation-runner.mjs --live    # LIVE
import { klassifiziereMailBatch } from '../klassifikation.js';

const args = process.argv.slice(2);
const LIVE = args.includes('--live');
const BASE_URL = process.env.SMOKE_BASE_URL || 'http://localhost:3000';

const MOCKS = [
  { konto: 'nadine.iva.inbox@gmail.com', bereich: 'HeatHero', an: 'info@heat-hero.com',
    von: 'mailer-daemon@googlemail.com', betreff: 'Delivery Status Notification (Failure)', ungelesen: true },
  { konto: 'nadine.iva.inbox@gmail.com', bereich: 'HeatHero', an: 'info@heat-hero.com',
    von: 'kai.schneider@example.de', betreff: 'Re: Ihr Angebot Waermepumpe - Rueckfrage zur Foerderung', ungelesen: true,
    preview: 'Hallo Frau Sell, koennen Sie mir noch sagen, ob die 30% BAFA-Foerderung auch fuer unser Baujahr gilt? Vielen Dank.' },
  { konto: 'nadine.iva.inbox@gmail.com', bereich: 'Goals & Concepts', an: 'kontakt@goalsandconcepts.de',
    von: 'noreply@calendly.com', betreff: 'Neue Buchung: Erstgespraech Coaching am 5.8.', ungelesen: false },
  { konto: 'nadine.iva.inbox@gmail.com', bereich: 'HeatHero', an: 'info@heat-hero.com',
    von: 'lisa.mueller@example.de', betreff: 'Bitte um Rueckruf morgen Vormittag', ungelesen: true,
    preview: 'Hallo Frau Sell, ich habe zu Ihrem Angebot noch Fragen. Koennen Sie mich morgen zwischen 9 und 11 anrufen? Nummer 0170-1234567.' },
  { konto: 'nadine.iva.inbox@gmail.com', bereich: 'Sol Living', an: 'info@sol-living.de',
    von: 'peter.klausen@example.de', betreff: 'Absage - kein Interesse mehr', ungelesen: true,
    preview: 'Hallo, wir haben uns anders entschieden. Bitte streichen Sie uns aus Ihrem Verteiler. Vielen Dank.' },
  { konto: 'nadine.iva.inbox@gmail.com', bereich: 'Privat (Outlook)', an: 'sell.nadine@outlook.de',
    von: 'abwesenheit@partnerfirma.de', betreff: 'Automatische Antwort: Bin bis 5.8. im Urlaub', ungelesen: false },
  { konto: 'nadine.iva.inbox@gmail.com', bereich: 'HeatHero', an: 'info@heat-hero.com',
    von: 'newsletter@t3n.de', betreff: 'T3N Wochennews: KI, Startups, Gruenderszene', ungelesen: false },
];

function padRight(s, n) { s = String(s || ''); return s.length >= n ? s.slice(0, n - 1) + '…' : s + ' '.repeat(n - s.length); }
function padLeft(s, n) { s = String(s || ''); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }
function short(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

async function loadMails() {
  if (!LIVE) return { mails: MOCKS, source: 'MOCK (7 Beispielmails)' };
  const url = BASE_URL.replace(/\/$/, '') + '/api/mails/klassifiziert?limit=15';
  const headers = process.env.API_TOKEN ? { Authorization: 'Bearer ' + process.env.API_TOKEN } : {};
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`LIVE-Endpoint HTTP ${r.status}`);
  const data = await r.json();
  return { live: data, source: `LIVE ${url}` };
}

function fmt(res, meta) {
  const KAT_LABEL = {
    disqualifiziert:  '[DISQUAL]  disqualifiziert',
    keine_antwort:    '[NO-REPLY] keine Antwort',
    erneut_anrufen:   '[CALL]     erneut anrufen',
    rueckfrage_offen: '[QUESTION] Rueckfrage offen',
    sonstiges:        '[-]        sonstiges',
  };
  console.log('\n' + '='.repeat(140));
  console.log('IVA — Mail-Klassifikation');
  console.log('='.repeat(140));
  console.log(`Quelle:  ${meta.source}`);
  if (meta.meta) console.log(`Modell:  ${meta.meta.modell}  |  Anzahl: ${meta.meta.anzahl}  |  Dauer: ${meta.meta.dauerMs} ms  |  Tokens: in=${meta.meta.tokensIn}/out=${meta.meta.tokensOut}`);
  console.log('');
  console.log(padRight('#', 3) + padRight('BEREICH', 18) + padRight('VON', 34) + padRight('BETREFF', 42) + padRight('KATEGORIE', 22) + 'VORSCHLAG');
  console.log('-'.repeat(140));
  const counts = {};
  res.forEach((r, i) => {
    counts[r.kategorie] = (counts[r.kategorie] || 0) + 1;
    const vor = r.vorschlag ? `${r.vorschlag.aktion}: ${short(r.vorschlag.hinweis, 55)}` : '';
    console.log(
      padRight(i + 1, 3)
      + padRight(r.bereich, 18)
      + padRight(short(r.von, 33), 34)
      + padRight(short(r.betreff, 41), 42)
      + padRight(KAT_LABEL[r.kategorie] || r.kategorie, 22)
      + vor,
    );
  });
  console.log('-'.repeat(140));
  const grouped = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${KAT_LABEL[k] || k}: ${v}`).join('  |  ');
  console.log('Zusammenfassung: ' + grouped);
  console.log('\nHinweis: alle "vorschlag.aktion"-Werte sind Vorschlaege. Es wird NICHTS ins CRM geschrieben.');
}

(async () => {
  const loaded = await loadMails();
  if (loaded.live) {
    // LIVE-Response ist bereits klassifiziert
    fmt(loaded.live.ergebnisse, { source: loaded.source, meta: loaded.live._meta });
    return;
  }
  console.log(`Klassifiziere ${loaded.mails.length} Mails (Modus: MOCK) via Anthropic Haiku ...`);
  const out = await klassifiziereMailBatch(loaded.mails);
  fmt(out.ergebnisse, { source: loaded.source, meta: out._meta });
})().catch(e => { console.error('FEHLER:', e.message); process.exit(1); });
