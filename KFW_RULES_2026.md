# KfW 458 – geprüfter Rechnerstand

Verifiziert am 15.09.2026: [KfW-Merkblatt 07/2026, gültig ab 21.07.2026](https://www.kfw.de/PDF/Download-Center/F%C3%B6rderprogramme-(Inlandsf%C3%B6rderung)/PDF-Dokumente/6000005131_M_458.pdf), [KfW-Änderungsübersicht](https://www.kfw.de/PDF/Download-Center/F%C3%B6rderprogramme-(Inlandsf%C3%B6rderung)/PDF-Dokumente/Infografik_Heizungsf%C3%B6rderung_Anpassungen_Juli_2026.pdf).

Grundförderung 30 %. Kostenobergrenze 28.000 € erste WE, 15.000 € WE 2–6, danach je 8.000 €. Erste-WE-Grenze sinkt ab 01.02.2027 halbjährlich um 750 €. Klimageschwindigkeit 16 %, ab Februar 2027 12 %, August 2027 8 %, Februar 2028 4 %, August 2028 0 %. Antragsdatum entscheidet.

Einkommensbonus: 40/30/10 % bei Haushalt-zvE bis 30/40/50 Tsd. €. Förderfähiges minderjähriges Kind verschiebt alle Grenzen einmalig um 10 Tsd. €. Obergrenze 70 %, im höchsten Einkommensbonus-Tarif 80 %. Maßgeblich sind die Steuerbescheide des zweiten und dritten Vorjahres, für 2026 also 2023/2024. Minderjährigkeit, Kindergeldberechtigung und Haupt-/Alleinwohnsitz gelten am Antragsdatum. Effizienz-/Emissionsbonus entfallen.

Bei MFH: Grundförderung auf Gebäudekosten, persönliche Boni ausschließlich auf eine selbstgenutzte WE. Ungeteiltes MFH: gleicher Kostenanteil pro WE. WEG: Miteigentumsanteil, höchstens Gebäudekostengrenze / WE. Zusatzantrags-Raten beziehen sich auf den Basisantrag.

## Eingabevertrag

`calculateKfw458Funding(input, now)` erfordert ein striktes `applicationDate` (`YYYY-MM-DD`). Zusatzantrag: `applicationKind: 'supplementary'` plus `baseApplicationDate`. Keine automatische Übernahme des heutigen Datums.

Bei Eigennutzung ist `incomeBonusRequested` ausdrücklich `true` oder `false`. Eine Einkommensangabe allein beantragt keinen Bonus. Nur `true` aktiviert folgende Pflichtnachweise:

```js
{
  incomeBonusRequested: true,
  incomeEvidence: {
    householdComplete: true,
    assessments: [
      { year: 2023, householdTaxableIncome: 25000, verified: true, sourceId: 'Aktenverweis 2023' },
      { year: 2024, householdTaxableIncome: 27000, verified: true, sourceId: 'Aktenverweis 2024' }
    ]
  },
  eligibleMinorChild: false
}
```

Beträge sind vollständig geprüfte Haushaltssummen aller maßgeblichen Eigentümer und Partner, numerisch in Euro; `sourceId` verweist auf zugehörige Steuerbescheide. Das Beispiel ist synthetisch. Ein optionales `householdIncome` muss mit dem berechneten Durchschnitt übereinstimmen.

Bei `eligibleMinorChild: true` zusätzlich `childEvidence` mit `verified`, `minor`, `childBenefitEligible`, `mainResidenceMatched` jeweils `true`, belegtem `sourceId` und dem passenden `applicationDate`. Diese Flags dürfen nur nach tatsächlicher Prüfung gesetzt werden. Die Oberfläche erfasst Aktenverweise und eine ausdrückliche Prüferbestätigung; sie lädt oder verifiziert Steuerdokumente nicht selbst.

## Ergebnis und Grenzen

- `calculationReady`: alle für die finanzielle Rechnung erforderlichen Angaben vorhanden. Sonst Geldbeträge und Prozentsätze `null`, Anzeige „Noch offen“.
- `canUseForFundingNote`: zusätzlich sämtliche Vorbedingungen bestätigt und kein zukünftiger Antrag. Konsumenten müssen dieses Feld prüfen; ein Zahlenwert allein ist kein Freigabenachweis.
- `isProjection`: zukünftiger Antrag, nur unverbindliche Planung anhand veröffentlichter Staffel. Kein operativer Fördernotiz-Abschluss.
- Anträge vor 21.07.2026 oder nach 31.12.2030 werden nicht mit diesem Regelwerk berechnet. `rulesVersion` muss, sofern angegeben, `kfw-458-2026-07-21` sein.
- Jahresübergreifender Basis-/Zusatzantrag mit Einkommensbonus, Teilanlagen und bereits verbrauchte Gebäudekostengrenzen bleiben offen, bis deren konkrete Berechnung fachlich ergänzt ist.
- Kein Ersatz für BzA, Förderzusage oder Prüfung zusätzlicher Vorhabenausschlüsse. Kein automatischer Förderantrag und kein Versand.

Prüfung: `node scripts/verify-funding-calculation.mjs` und `node scripts/verify-energy-calculations.mjs`.
