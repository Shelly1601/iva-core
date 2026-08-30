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
const isoYear = Number(argument('year', '2026'));
const firstWeek = Number(argument('start-week', '36'));
const lastWeek = Number(argument('end-week', '45'));
if (![isoYear, firstWeek, lastWeek].every(Number.isInteger) || lastWeek - firstWeek !== 9) {
  throw new Error('Forecast-Daten benötigen ein Jahr und genau zehn Kalenderwochen.');
}
await mkdir(outputDirectory, { recursive: true });
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
