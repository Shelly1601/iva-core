import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { collectAndBuildPlanbarForecast } from '../local-mac-helper/planbar-forecast.mjs';

function argument(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

if (process.argv.includes('--from-existing')) {
  throw new Error('Forecast-Abbruch: --from-existing ist für Planbar-Forecasts nicht mehr zulässig. Planbar muss zuerst neu eingelesen werden.');
}
const outputDirectory = path.resolve(argument('output', process.argv[2] || 'outputs/planbar-weekly/current'));
const isoYear = Number(argument('year'));
const firstWeek = Number(argument('start-week'));
const lastWeek = Number(argument('end-week'));
if (![isoYear, firstWeek, lastWeek].every(Number.isInteger) || isoYear < 2026 || firstWeek < 1 || lastWeek - firstWeek !== 9) {
  throw new Error('Forecast-Daten benötigen ausdrücklich --year, --start-week und --end-week für den aktuellen Zehn-Wochen-Zeitraum. Ein historischer Standardzeitraum wird nicht verwendet.');
}
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
const outputFile = path.join(outputDirectory, 'forecast-data.json');
const rowsFile = path.join(outputDirectory, 'data.json');
const result = await collectAndBuildPlanbarForecast({ isoYear, firstWeek, lastWeek });
await writeFile(outputFile, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
await writeFile(rowsFile, `${JSON.stringify(result.forecast.sourceRows, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({
  outputFile,
  rowsFile,
  period: `KW ${firstWeek}-${lastWeek} / ${isoYear}`,
  sourceEntries: result.source.entries.length,
  sourceRows: result.forecast.sourceRows.length,
  rows: result.forecast.rowCount,
  excluded: result.forecast.excludedCount,
  manufacturers: Object.fromEntries(Object.entries(result.forecast.byManufacturer).map(([name, rows]) => [name, rows.length])),
}, null, 2));
