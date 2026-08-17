# IVA-Projekt Heat Hero – digitaler Innendienstvertrieb

## Ziel

HeatHero CRM ist die führende Vertriebsquelle. IVA führt Plattform- und Hersteller-Leads hinein, begleitet den digitalen Kundentermin, sammelt technische Daten in einer gemeinsamen Energie-Fallakte und bereitet TMB, Planung, Angebot und Herstellerrückmeldung vor. Vertriebspartner und Innendienst pflegen keine parallelen Herstellerlisten.

Die Kundschaft soll nicht allein einen komplexen technischen Fragebogen ausfüllen. Der Standard ist ein geführter Videotermin mit einem sehr einfachen Kundenlink. Die Beraterin sieht live, welche Aufgabe der Kunde gerade bearbeitet, welches Bild angekommen ist und ob eine Angabe technisch brauchbar ist.

## Kundenerlebnis

### Vor dem Termin

Der Kunde erhält einen Link ohne App-Installation und ohne separates Passwort. Die Nachricht enthält nur drei Vorbereitungen:

1. Zollstock oder Maßband bereitlegen.
2. Grundriss und möglichst einen Verbrauchsnachweis bereitlegen oder vorab hochladen.
3. Smartphone laden und beim Termin damit teilnehmen.

Alles Weitere wird im Termin gemeinsam erledigt. Optional kann eine Vertrauensperson teilnehmen.

### Im Videotermin

Die Berateransicht und die Kundenansicht hängen an derselben IVA-Fallakte. Der Berater löst jeweils genau eine Aufgabe auf dem Kundentelefon aus, zum Beispiel „Bitte fotografieren Sie jetzt das Typenschild der Heizung“. Das Bild erscheint sofort im Berater-Cockpit.

Pflichtaufnahmen werden dynamisch gewählt; Ziel sind höchstens zehn:

- Gesamtgebäude außen;
- geplanter Standort der Außeneinheit;
- Heizraum als Übersicht;
- Bestandsheizung und Typenschild;
- Hydraulik/Rohre mit Maßbezug;
- Elektroverteilung;
- Zähleranlage;
- schmalste Stelle auf dem Transportweg;
- relevanter Leitungsweg;
- nur falls nötig Heizkörper, Fußbodenheizungsverteiler, PV oder Tank/Lager.

Maße werden nicht nur als Zahl eingegeben. Wo möglich wird ein Foto mit sichtbarem Zollstock verlangt. Kritische Maße werden zweimal oder aus zwei Quellen gegengeprüft.

## Qualitätskontrolle

Eine absolute Garantie gibt es bei einer Remote-Aufnahme nicht. Die Qualität wird deshalb durch technische und organisatorische Gates abgesichert:

- **Grün:** vollständig, lesbar, plausible Einheit, eindeutige Quelle und – bei kritischen Feldern – vom Berater bestätigt.
- **Gelb:** grundsätzlich brauchbar, aber Widerspruch, schwache Bildqualität oder fehlende Gegenprüfung. Muss im Gespräch geklärt werden.
- **Rot:** Pflichtangabe fehlt oder technische Planung wäre unsicher. TMB, Auslegung oder Angebot bleibt blockiert.

Die automatische Prüfung kontrolliert beispielsweise Bildschärfe, richtige Motivkategorie, lesbares Typenschild, vorhandenen Maßbezug, plausible Größenordnung und Widersprüche zwischen Grundriss, Kundenaussage, Foto und Verbrauch. KI darf Felder vorschlagen, aber keine fehlenden Werte erfinden.

## Sales Coach und TMB

Nach dokumentierter Einwilligung werden Gesprächsaussagen transkribiert. IVA schlägt daraus einzelne TMB-Felder vor und speichert zu jedem Vorschlag:

- Originalaussage mit Zeitstempel;
- Datenquelle (Gespräch, Foto, Grundriss, CRM oder Berater);
- Confidence;
- Prüfstatus;
- bestätigende Person und Zeitpunkt.

Der Berater bestätigt oder korrigiert die Vorschläge während des Gesprächs. Das Rohtranskript ersetzt keine Bestätigung für technische Pflichtwerte. Am Ende zeigt IVA nur noch die offenen gelben und roten Punkte.

## Grundriss, 3D und Leitungsweg

Ein hochgeladener Grundriss wird als Entwurf erkannt. IVA schlägt Wände, Räume, Fenster und Türen vor; ein Kontrollmaß skaliert das Modell. Der Berater bestätigt den Entwurf. Danach werden Heizkörper, Innen-/Außeneinheit, Speicher und Leitungsweg platziert.

Aus dem bestätigten Modell können Rohrmeter, Wanddurchbrüche, Höhenunterschiede und Engstellen berechnet werden. Die Berechnung muss ihre Route sichtbar zeigen, damit der Berater sie korrigieren kann.

## Heizlast und Anlagenauslegung

Das vorhandene IVA-Modul ist eine transparente Heizlast-Vorplanung, noch kein vollständiger DIN-Nachweis. Für die produktive Auslegung braucht es eine deterministische, fachlich abgenommene Engine nach den relevanten Regeln. Eingaben umfassen unter anderem:

- Geometrie und beheizte Räume;
- Norm-Außentemperatur und Raum-Solltemperaturen;
- Bauteilflächen und U-Werte beziehungsweise belegte Baualters-/Sanierungsannahmen;
- Fenster, Dach, Keller und Außenwanddämmung;
- Luftwechsel und Wärmebrücken;
- Verbrauchsplausibilisierung;
- Heizflächen und erforderliche Vorlauftemperatur;
- Warmwasser und relevante Zuschläge;
- Leistungsdaten der konkreten Wärmepumpe bei Auslegungspunkt.

Die Engine weist Annahmen, fehlende Eingaben, Regelversion und Ergebnis je Raum aus. Für kritische oder unvollständige Fälle ist eine fachliche Freigabe Pflicht.

## Angebots-KI

Die Angebots-KI darf erst rechnen, wenn technische Pflichtgates grün sind. Sie nutzt keine frei formulierten Modellpreise, sondern versionierte Daten:

- Hersteller- und Artikelstamm;
- Einkaufspreis, Gültigkeitszeitraum und Lieferbarkeit;
- Arbeitszeit- und Montagepakete;
- Rohrmeter, Kernbohrungen, Elektroarbeiten, Fundament, Gerüst/Kran und Entsorgung;
- Zuschläge, Rabatte, Marge und Umsatzsteuer;
- Kompatibilitäts- und Pflichtpositionsregeln;
- freigegebene Beispielangebote als Testfälle, nicht als alleinige Wahrheit.

Ausgabe sind eine nachvollziehbare Stückliste, Kalkulation und Kundenvariante. Preisstand und technische Freigabe werden im Angebot dokumentiert.

## CRM und Hersteller

Beim Leadimport werden Plattform-ID, Hersteller-ID und HeatHero-CRM-ID fest verknüpft. CRM-Ereignisse treiben den Prozess:

- Termin gesetzt → terminiert;
- Termin durchgeführt → Beratung erfolgt;
- Angebot erstellt/versendet → Angebot vorhanden;
- Auftrag gewonnen/verloren → entsprechender Herstellerstatus mit Beleg und gegebenenfalls Grund.

Panasonic und Bosch erhalten getrennte Mappingtabellen. IVA schreibt nur erlaubte Vorwärtsübergänge, verifiziert anschließend die sichtbare Portaländerung und protokolliert Quelle, alten/neuen Status und Ergebnis.

## Umsetzungsreihenfolge

1. Kundenlink und geführte Live-Aufnahme auf der vorhandenen Energie-Fallakte.
2. Echtzeit-Vollständigkeit, Foto-/Maßprüfung und Beraterschlussprüfung.
3. Sales-Coach-Feldvorschläge in die TMB.
4. Bestätigbarer 3D-Grundriss und Leitungsweg.
5. Fachlich abgenommene Heizlast-/Auslegungsengine.
6. Versionierte Preislisten und Angebots-KI.
7. Vollständiger CRM-/Hersteller-Rückkanal.

Der erste MVP endet bewusst nach Schritt 2: Er beseitigt bereits den größten operativen Engpass und liefert verlässliche Eingangsdaten für die späteren Rechen- und Angebotsmodule.
