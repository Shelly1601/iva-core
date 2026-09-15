import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { calculateKfw458Funding as calculate, eligibleCostCap, climateSpeedBonusRate, incomeBonusRate } from '../workspaces/energy-calculations.js';

const NOW = new Date('2026-09-15T10:00:00+02:00');
const basic = { applicantType: 'private-owner', selfUsed: true, units: 1, projectCosts: 28_000,
  existingBuildingAgeYears: 20, applicationDate: '2026-08-01', incomeBonusRequested: false,
  climateBonusEligible: true, eligibleCostsConfirmedByBza: true, contractConditional: true,
  applicationBeforeStart: true, hydraulicBalancingPlanned: true };
function income(amount, extra = {}) { return { incomeBonusRequested: true, eligibleMinorChild: false,
  incomeEvidence: { householdComplete: true, assessments: [2023, 2024].map(year => ({ year, householdTaxableIncome: amount, verified: true, sourceId: 'fixture-assessment-' + year })) }, ...extra }; }
function child() { return { eligibleMinorChild: true, childEvidence: { verified: true, minor: true, childBenefitEligible: true, mainResidenceMatched: true, sourceId: 'fixture-child-proof', applicationDate: '2026-08-01' } }; }
const calc = patch => calculate({ ...basic, ...patch }, NOW);
function unavailable(result) { assert.equal(result.calculationReady, false); assert.equal(result.canUseForFundingNote, false); assert.equal(result.estimatedGrant, null); assert.equal(result.rate, null); assert.doesNotMatch(result.noteSummary, /0 %|0,00 €/); }

test('income amount alone never applies a bonus; explicit no ignores stored income', () => {
  unavailable(calc({ incomeBonusRequested: undefined, householdIncome: 20_000 }));
  const result = calc({ householdIncome: 20_000, ...income(20_000), incomeBonusRequested: false });
  assert.equal(result.rate, 46); assert.equal(result.bonuses.income, 0); assert.equal(result.canUseForFundingNote, true); assert.match(result.noteSummary, /nicht beantragt/);
});
test('unrequested low income and child metadata cannot silently lift the cap', () => {
  assert.equal(calc({ householdIncome: 20_000, ...child() }).maximumUnitRate, 70);
});
test('income requires both correct tax years, complete household and actual proof references', () => {
  for (const evidence of [undefined, { householdComplete: false }, { ...income(20_000).incomeEvidence, assessments: income(20_000).incomeEvidence.assessments.slice(0, 1) },
    { ...income(20_000).incomeEvidence, assessments: income(20_000).incomeEvidence.assessments.map(row => ({ ...row, year: row.year + 1 })) },
    { ...income(20_000).incomeEvidence, assessments: income(20_000).incomeEvidence.assessments.map(row => ({ ...row, sourceId: '' })) },
    { ...income(20_000).incomeEvidence, assessments: income(20_000).incomeEvidence.assessments.map(row => ({ ...row, verified: false })) },
    { ...income(20_000).incomeEvidence, assessments: income(20_000).incomeEvidence.assessments.map(row => ({ ...row, householdTaxableIncome: '20000' })) },
    { ...income(20_000).incomeEvidence, assessments: [...income(20_000).incomeEvidence.assessments, income(20_000).incomeEvidence.assessments[0]] }]) unavailable(calc({ ...income(20_000), incomeEvidence: evidence }));
});
test('household mean is calculated from documents, differing supplied income is rejected', () => {
  const proof = income(20_000); proof.incomeEvidence.assessments[1].householdTaxableIncome = 50_000;
  const result = calc(proof); assert.equal(result.verifiedHouseholdIncome, 35_000); assert.equal(result.rate, 70);
  unavailable(calc({ ...proof, householdIncome: 20_000 }));
});
test('income thresholds and family shift include exact boundaries and negative taxable income', () => {
  for (const [value, rate] of [[-100,40],[30000,40],[30000.01,30],[40000,30],[40000.01,10],[50000,10],[50000.01,0]]) {
    assert.equal(incomeBonusRate(value), rate); assert.equal(incomeBonusRate(value + 10000, true), rate);
  }
});
test('highest income tier uses 80 percent ceiling, next tier uses 70 percent', () => {
  const top = calc(income(30_000)), next = calc(income(30_000.01));
  assert.equal(top.uncappedRate, 86); assert.equal(top.rate, 80); assert.equal(top.estimatedGrant, 22400);
  assert.equal(next.uncappedRate, 76); assert.equal(next.rate, 70); assert.equal(next.estimatedGrant, 19600);
});
test('child shift needs every child eligibility proof and matching application day', () => {
  unavailable(calc({ ...income(35_000), eligibleMinorChild: undefined }));
  unavailable(calc({ ...income(35_000), eligibleMinorChild: true }));
  for (const field of ['verified', 'minor', 'childBenefitEligible', 'mainResidenceMatched']) unavailable(calc({ ...income(35_000), ...child(), childEvidence: { ...child().childEvidence, [field]: false } }));
  unavailable(calc({ ...income(35_000), ...child(), childEvidence: { ...child().childEvidence, applicationDate: '2026-07-31' } }));
  assert.equal(calc({ ...income(35_000), ...child() }).rate, 80);
});
test('rental building gets only whole-building base, personal bonuses cannot leak to it', () => {
  const result = calc({ units: 3, projectCosts: 58_000, buildingStructure: 'unpartitioned', selfUsed: false, ...income(20_000), ...child() });
  assert.equal(result.estimatedGrant, 17400); assert.equal(result.rate, 30); assert.equal(result.selfUsedUnitAdditionalGrant, 0);
});
test('unpartitioned two-unit building matches KfW component example', () => {
  const result = calc({ units: 2, projectCosts: 41_000, buildingStructure: 'unpartitioned', ...income(35_000), ...child() });
  assert.equal(result.buildingBaseGrant, 12300); assert.equal(result.selfUsedUnitEligibleCosts, 20500);
  assert.equal(result.selfUsedUnitAdditionalGrant, 10250); assert.equal(result.estimatedGrant, 22550); assert.match(result.noteSummary, /^22\.550,00 € - 30 % Gesamtgebäude \/ 80 % selbst genutzte WE/);
});
test('WEG bonus respects ownership share and separate per-unit ceiling', () => {
  const result = calc({ units: 7, projectCosts: 111000, buildingStructure: 'weg', ownershipSharePercent: 12, ...income(20_000) });
  assert.equal(result.buildingBaseGrant, 33300); assert.equal(result.selfUsedUnitEligibleCosts, 13320); assert.equal(result.selfUsedUnitAdditionalGrant, 6660); assert.equal(result.estimatedGrant, 39960);
  const capped = calc({ units: 7, projectCosts: 111000, buildingStructure: 'weg', ownershipSharePercent: 90, ...income(20_000) });
  assert.equal(capped.selfUsedUnitEligibleCosts, 15857.14); assert.equal(capped.selfUsedUnitAdditionalGrant, 7928.57);
  for (const ownershipSharePercent of [undefined,0,-1,101]) unavailable(calc({ units: 7, buildingStructure: 'weg', ownershipSharePercent }));
});
test('date guards reject missing, invalid, old, unknown rule versions and unverified far future', () => {
  for (const applicationDate of [undefined,'','2026-02-30','2026-8-1','2026-07-20','2031-01-01']) unavailable(calc({ applicationDate }));
  unavailable(calc({ rulesVersion: 'unverified-next-version' }));
});
test('calendar boundaries determine speed rate and descending cost cap', () => {
  for (const [day, cap, speed] of [['2026-07-21',28000,16],['2027-01-31',28000,16],['2027-02-01',27250,12],['2027-07-31',27250,12],['2027-08-01',26500,8],['2028-02-01',25750,4],['2028-08-01',25000,0],['2030-08-01',22000,0]]) {
    assert.equal(eligibleCostCap(1, day), cap); assert.equal(eligibleCostCap(7, day), cap+83000); assert.equal(climateSpeedBonusRate(day), speed);
  }
  assert.equal(climateSpeedBonusRate(new Date('2027-01-31T23:30:00Z')),12);
  assert.equal(eligibleCostCap(0),null); assert.equal(eligibleCostCap(1.5),null);
});
test('future application is visibly a projection and never ready for operative funding note', () => {
  const result = calc({ applicationDate: '2027-02-01' });
  assert.equal(result.calculationReady,true); assert.equal(result.isProjection,true); assert.equal(result.canUseForFundingNote,false); assert.equal(result.rate,42); assert.equal(result.eligibleCostCap,27250); assert.match(result.noteSummary,/Unverbindliche Planung/);
});
test('historic August application uses its own date even when recalculated after schedule step', () => {
  const result = calculate(basic,new Date('2027-03-02T10:00:00Z'));
  assert.equal(result.eligibleCostCap,28000); assert.equal(result.bonuses.climateSpeed,16);
});
test('supplementary application uses base date; missing or impossible base is blocked', () => {
  const result = calc({ applicationKind:'supplementary',applicationDate:'2027-02-01',baseApplicationDate:'2026-08-01',units:2,buildingStructure:'unpartitioned' });
  assert.equal(result.bonuses.climateSpeed,16); assert.equal(result.eligibleCostCap,43000);
  unavailable(calc({ applicationKind:'supplementary' }));
  unavailable(calc({ applicationKind:'supplementary',baseApplicationDate:'2026-09-01' }));
  unavailable(calc({ ...income(20000),applicationKind:'supplementary',applicationDate:'2027-02-01',baseApplicationDate:'2026-08-01' }));
});
test('partial systems, consumed prior cap and incomplete essential data do not produce invented grants', () => {
  for (const patch of [{ allUnitsAffected:false },{ previousEligibleCosts:100 },{ units:0 },{ units:1.5 },{ units:3 },{ projectCosts:299 },{ selfUsed:undefined },{ climateBonusEligible:undefined },{ applicantType:'other' }]) unavailable(calc(patch));
});
test('open BzA and contract prerequisites keep calculation separate from approval', () => {
  const result=calc({ eligibleCostsConfirmedByBza:false,contractConditional:false });
  assert.equal(result.calculationReady,true); assert.equal(result.canUseForFundingNote,false); assert.equal(result.status,'precheck-incomplete');
});

test('funding UI keeps unknown fields null and renders them as open rather than zero', async () => {
  const js=await readFile(new URL('../public/workspace.js',import.meta.url),'utf8');
  const values={ incomeBonusRequested:'', eligibleMinorChild:'', fundingTaxYear1:'2023', fundingTaxIncome1:'', fundingTaxSource1:'' };
  const fields={}; const element=()=>({children:[],style:{},textContent:'',append(...nodes){this.children.push(...nodes)},appendChild(node){this.children.push(node)},replaceChildren(){this.children=[]}});
  fields.fundingResult=element();
  const context=vm.createContext({ val:id=>values[id]||'',checked:()=>false,$:id=>fields[id],document:{createElement:element} });
  vm.runInContext(js.slice(js.indexOf('function fundingBoolean('),js.indexOf('function collectEnergyData(')),context);
  const collected=vm.runInContext('collectFundingEvidence()',context);
  assert.equal(collected.incomeBonusRequested,null); assert.equal(collected.eligibleMinorChild,null); assert.equal(collected.incomeEvidence.assessments[0].householdTaxableIncome,null);
  context.current={data:{funding:{allUnitsAffected:false,previousEligibleCosts:4000}}}; context.rooms=[]; context.photoAssignments={};
  vm.runInContext(js.slice(js.indexOf('function collectEnergyData('),js.indexOf('function collect()')),context);
  const saved=vm.runInContext('collectEnergyData()',context); assert.equal(saved.funding.allUnitsAffected,false); assert.equal(saved.funding.previousEligibleCosts,4000);
  vm.runInContext(js.slice(js.indexOf('function calcValue('),js.indexOf('async function calculateEnergy(')),context);
  context.result=calc({incomeBonusRequested:undefined}); vm.runInContext('renderFundingResult(result)',context);
  const text=node=>[node.textContent,...node.children.flatMap(text)].join(' ');
  assert.match(text(fields.fundingResult),/Noch offen/); assert.doesNotMatch(text(fields.fundingResult),/0,00 €|0 %/);
});
