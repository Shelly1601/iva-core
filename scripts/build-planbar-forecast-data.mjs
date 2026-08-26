import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { buildPlanbarForecast, collectAndBuildPlanbarForecast } from '../local-mac-helper/planbar-forecast.mjs';

const outputDirectory = path.resolve(process.argv[2] || 'outputs/planbar-weekly/2026-08-26-kw36-45');
await mkdir(outputDirectory, { recursive: true });
const outputFile = path.join(outputDirectory, 'forecast-data.json');
let result;
if (process.argv.includes('--from-existing')) {
  const existing = JSON.parse(await readFile(outputFile, 'utf8'));
  if (!Array.isArray(existing?.source?.entries)) throw new Error('Die bestehende Forecast-Quelldatei ist unvollständig.');
  result = { source: existing.source, forecast: buildPlanbarForecast(existing.source.entries) };
} else {
  result = await collectAndBuildPlanbarForecast();
}
await writeFile(outputFile, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({
  outputFile,
  sourceEntries: result.source.entries.length,
  rows: result.forecast.rowCount,
  excluded: result.forecast.excludedCount,
  manufacturers: Object.fromEntries(Object.entries(result.forecast.byManufacturer).map(([name, rows]) => [name, rows.length])),
}, null, 2));
