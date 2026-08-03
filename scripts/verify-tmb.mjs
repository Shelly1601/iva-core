import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import assert from 'assert/strict';
import zlib from 'zlib';
import { createTmbPdf } from '../workspaces/tmb-pdf.js';

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function createSamplePng(width = 320, height = 180) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const start = y * (width * 3 + 1);
    raw[start] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = start + 1 + x * 3;
      raw[offset] = 36;
      raw[offset + 1] = Math.round(90 + 90 * (x / width));
      raw[offset + 2] = Math.round(140 + 80 * (y / height));
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-tmb-'));
process.env.DATA_DIR = testDir;

try {
  const store = await import('../workspaces/store.js?verify-tmb=' + Date.now());
  let workspace = await store.createWorkspace({
    mode: 'energie',
    title: 'Musterfall Waermepumpe',
    status: 'review',
    customer: {
      name: 'Familie Muster',
      address: 'Musterstrasse 1, 12345 Musterstadt',
      email: 'familie.muster@example.com',
      phone: '01234 567890',
    },
    data: {
      assessment: { visitDate: '2026-08-03', adviser: 'Nadine Beispiel', leadSource: 'Empfehlung' },
      building: {
        type: 'Einfamilienhaus', year: '1998', floors: '2', floorHeight: '2,50', heatedArea: '165',
        occupants: '4', construction: 'Massivbau', glazing: '2-fach', roof: 'Satteldach, 35 Grad',
        exteriorInsulation: '8 cm', roofInsulation: 'vorhanden', basement: 'voll unterkellert',
      },
      existingHeating: {
        energySource: 'Gas', manufacturer: 'Mustertherm', model: 'GT 20', installationYear: '2002',
        nominalPower: '24', boilerLocation: 'Keller', systemType: 'Heizkoerper und Fussbodenheizung',
        pipeSystem: 'Zweirohrsystem', pipeDiameter: '28 mm', flowTemperature: '55', hotWater: 'ueber Heizkessel',
        annualConsumption: '22000', consumptionUnit: 'kWh', consumptionPeriod: '2025', billAvailable: true,
      },
      heatPump: {
        desiredPosition: 'Nordseite neben Garage', indoorPosition: 'Heizraum Keller', distance: '8',
        accessWidth: '110', levelDifference: '1,2', route: 'durch Garage in den Heizraum',
        refrigerantPreference: 'R290', notes: 'Abstand zum Nachbarfenster pruefen',
      },
      site: { noiseSensitive: true, accessNotes: 'Zufahrt ueber gepflasterte Einfahrt' },
      hydraulics: { underfloorHeating: true, circulationPumps: '1 Hocheffizienzpumpe', bufferTank: 'nicht vorhanden' },
      electrical: { serviceAmps: '3 x 63 A', meterType: 'digital', freeSlots: '4 TE', upgradeNeeded: 'no' },
      pv: { present: true, power: '9,8', batteryPresent: true, batteryCapacity: '10', solarThermal: false },
      rooms: [
        {
          floor: 'EG', name: 'Wohnzimmer', use: 'Wohnen', area: '32', height: '2,50',
          radiators: [
            { type: 'Plattenheizkoerper', panelType: '22', width: '1600', height: '600', depth: '105' },
            { type: 'Plattenheizkoerper', panelType: '22', width: '1000', height: '600', depth: '105' },
          ],
        },
        {
          floor: 'OG', name: 'Bad', use: 'Bad', area: '12', height: '2,45',
          radiators: [{ type: 'Badheizkoerper', width: '600', height: '1800', depth: '80', notes: 'Handtuchheizkoerper' }],
        },
      ],
      declaration: { reviewed: true, reviewedBy: 'Nadine Beispiel', reviewedAt: '2026-08-03', notes: 'Muster zur Layoutpruefung.' },
    },
    visit: { consent: { granted: true, method: 'schriftlich' }, plaud: { recordingId: 'test-aufnahme' } },
  });

  const pixelPng = createSamplePng();
  const photo = await store.storeWorkspaceFile(workspace.id, {
    name: 'waermepumpe-standort.png', mime: 'image/png', kind: 'photo', buffer: pixelPng,
  });
  workspace = await store.updateWorkspace(workspace.id, {
    data: { photoAssignments: [{ fileId: photo.id, category: 'waermepumpe-standort', note: 'Musterfoto fuer die Standortzuordnung.' }] },
    status: 'review',
  });

  const pdf = await createTmbPdf(workspace, { readFile: store.readWorkspaceFile });
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  assert.ok(pdf.length > 10000, 'PDF ist unerwartet klein.');

  const outputDir = path.resolve('output/pdf');
  await fs.mkdir(outputDir, { recursive: true });
  const outputFile = path.join(outputDir, 'IVA-TMB-Muster.pdf');
  await fs.writeFile(outputFile, pdf);
  console.log(`PASS TMB: Datenmodell, Heizkoerper, Fotodokumentation und PDF (${pdf.length} Bytes)`);
  console.log(outputFile);
} finally {
  await fs.rm(testDir, { recursive: true, force: true });
}
