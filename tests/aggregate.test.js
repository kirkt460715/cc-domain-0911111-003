import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Harbor} from '../src/service.js';
import {serve} from '../src/api.js';
import {aggregateSpec} from '../src/aggregate.js';
import {kind} from './support.js';

async function aggregateSetup(t, rows) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harbor-agg-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  let time = '2026-11-01T00:00:00Z';
  const harbor = new Harbor(root, {clock: () => new Date(time)});
  await harbor.organization({id: 'owner', name: 'Institute', region: 'south',
    purposes: ['research'], stewards: ['alice', 'bob']}, 'bootstrap');
  await harbor.organization({id: 'partner', name: 'Partner', region: 'south',
    purposes: ['research'], stewards: ['carol']}, 'bootstrap');
  await harbor.dataset({id: 'events', name: 'Service events', owner: 'owner', schema: {
    columns: [
      {name: 'event_id', type: 'string', classification: 'public'},
      {name: 'person', type: 'string', classification: 'sensitive', nullable: true},
      {name: 'age_band', type: 'string', classification: 'public'},
      {name: 'district', type: 'string', classification: 'public'},
      {name: 'hours', type: 'integer', classification: 'public', minimum: 0},
    ], primaryKey: ['event_id']}}, 'alice');
  await harbor.import({dataset: 'events', importId: 'one', rows}, 'alice');
  await harbor.activate({dataset: 'events', version: 1}, 'alice');
  return {harbor, setTime: value => {time = value;}};
}

function fixtureRows() {
  return [
    {event_id: 'e1', person: 'p1', age_band: '18-30', district: 'delta', hours: 5},
    {event_id: 'e2', person: 'p1', age_band: '18-30', district: 'delta', hours: 7},
    {event_id: 'e3', person: 'p2', age_band: '18-30', district: 'delta', hours: 9},
    {event_id: 'e4', person: 'p3', age_band: '31-50', district: 'delta', hours: 11},
    {event_id: 'e5', person: 'p4', age_band: '31-50', district: 'hill', hours: 2},
    {event_id: 'e6', person: 'p5', age_band: '31-50', district: 'hill', hours: 4},
    {event_id: 'e7', person: 'p6', age_band: '51+', district: 'hill', hours: 6},
    {event_id: 'e8', person: 'p6', age_band: '51+', district: 'hill', hours: 8},
    {event_id: 'e9', person: null, age_band: '51+', district: 'hill', hours: 3},
  ];
}

function grant(overrides = {}) {
  return {id: 'g', dataset: 'events', recipient: 'partner', purposes: ['research'],
    columns: ['event_id', 'person', 'age_band', 'district', 'hours'],
    transforms: {person: {kind: 'tokenize'}},
    rowBudget: 100, releaseLimit: 10, expiresAt: '2026-12-01T00:00:00Z',
    minimumGroup: 2, quasiIdentifiers: ['district'], approvalCount: 2, ...overrides};
}

function aggregateRequest(overrides = {}) {
  return {id: 'aq', grant: 'g', reference: 'events:1', recipient: 'partner', purpose: 'research',
    mode: 'aggregate', expiresAt: '2026-11-20T00:00:00Z',
    aggregate: {
      groupBy: ['age_band', 'district'],
      subjectKey: 'person',
      measures: [{name: 'users', operation: 'count'}, {name: 'total_hours', operation: 'sum', source: 'hours'}],
      totals: true,
    }, ...overrides};
}

async function approvedAggregate(harbor, requestOverrides = {}, grantOverrides = {}) {
  await harbor.grant(grant(grantOverrides), 'alice');
  await harbor.request(aggregateRequest(requestOverrides), 'carol');
  await harbor.decide({id: 'aq', decision: 'approve', reason: 'purpose reviewed'}, 'alice');
  await harbor.decide({id: 'aq', decision: 'approve', reason: 'suppression reviewed'}, 'bob');
}

test('aggregate counts distinct subjects, ignores empty subjects and never double counts multi-row people', async t => {
  const {harbor} = await aggregateSetup(t, fixtureRows());
  await approvedAggregate(harbor);
  const status = await harbor.requestStatus('aq');
  assert.equal(status.mode, 'aggregate');
  const released = await harbor.release({id: 'ar', request: 'aq'}, 'alice');
  const fetched = await harbor.fetchRelease('ar', 'carol');
  const table = fetched.content.trim().split(String.fromCharCode(10)).map(JSON.parse);
  const grandTotal = table.find(row => row.cell === 'total');
  // 6 distinct non-null people across 9 rows; the null-subject row is not counted
  assert.equal(grandTotal.users, 6);
  assert.equal(grandTotal.total_hours, 5 + 7 + 9 + 11 + 2 + 4 + 6 + 8);
  assert.equal(released.manifest.rows, 0);
  assert.equal(released.manifest.suppression.primaryCells + released.manifest.suppression.complementaryCells,
    released.manifest.suppressedCells);
  assert.ok(!fetched.content.includes('p1'));
});

test('zero, no-record and suppressed cells are rendered as distinct states', async t => {
  const {harbor} = await aggregateSetup(t, fixtureRows());
  await approvedAggregate(harbor, {aggregate: {
    groupBy: ['age_band', 'district'], subjectKey: 'person',
    measures: [{name: 'users', operation: 'count'}, {name: 'total_hours', operation: 'sum', source: 'hours'}],
    totals: false}});
  await harbor.release({id: 'ar', request: 'aq'}, 'alice');
  const table = (await harbor.fetchRelease('ar', 'carol')).content.trim().split(String.fromCharCode(10)).map(JSON.parse);
  const states = new Set(table.map(row => row.state));
  assert.ok(states.has('suppressed'));
  assert.ok(states.has('no_records'));
  const noRecord = table.find(row => row.state === 'no_records');
  assert.equal(noRecord.users, null);
  const suppressed = table.find(row => row.state === 'suppressed');
  assert.equal(suppressed.users, null);
  assert.notEqual(noRecord.cell + noRecord.age_band + noRecord.district, suppressed.cell + suppressed.age_band + suppressed.district);
});

test('a populated count-only cell is published, not mislabeled zero', async t => {
  const rows = [
    {event_id: 'e1', person: 'p1', age_band: '18-30', district: 'delta', hours: 3},
    {event_id: 'e2', person: 'p2', age_band: '18-30', district: 'delta', hours: 4},
    {event_id: 'e3', person: 'p3', age_band: '31-50', district: 'hill', hours: 5},
    {event_id: 'e4', person: 'p4', age_band: '31-50', district: 'hill', hours: 6},
  ];
  const {harbor} = await aggregateSetup(t, rows);
  await approvedAggregate(harbor, {aggregate: {
    groupBy: ['district'], subjectKey: 'person',
    measures: [{name: 'users', operation: 'count'}], totals: false}});
  await harbor.release({id: 'ar', request: 'aq'}, 'alice');
  const table = (await harbor.fetchRelease('ar', 'carol')).content.trim().split(String.fromCharCode(10)).map(JSON.parse);
  assert.ok(table.every(row => row.state === 'published'));
  assert.deepEqual(table.map(row => row.users).sort(), [2, 2]);
});

test('a genuinely all-zero numeric cell is marked zero rather than suppressed or no-records', async t => {
  const rows = [
    {event_id: 'e1', person: 'p1', age_band: '18-30', district: 'delta', hours: 0},
    {event_id: 'e2', person: 'p2', age_band: '18-30', district: 'delta', hours: 0},
    {event_id: 'e3', person: 'p3', age_band: '31-50', district: 'hill', hours: 5},
    {event_id: 'e4', person: 'p4', age_band: '31-50', district: 'hill', hours: 7},
  ];
  const {harbor} = await aggregateSetup(t, rows);
  await approvedAggregate(harbor, {aggregate: {
    groupBy: ['district'], subjectKey: 'person',
    measures: [{name: 'users', operation: 'count'}, {name: 'total_hours', operation: 'sum', source: 'hours'}],
    totals: false}});
  await harbor.release({id: 'ar', request: 'aq'}, 'alice');
  const table = (await harbor.fetchRelease('ar', 'carol')).content.trim().split(String.fromCharCode(10)).map(JSON.parse);
  const delta = table.find(row => row.district === 'delta');
  assert.equal(delta.state, 'zero');
  assert.equal(delta.users, 2);
  assert.equal(delta.total_hours, 0);
});

test('complementary suppression prevents reconstructing a small cell by subtraction', async t => {
  const {harbor} = await aggregateSetup(t, fixtureRows());
  await approvedAggregate(harbor);
  await harbor.release({id: 'ar', request: 'aq'}, 'alice');
  const manifest = (await harbor.fetchRelease('ar', 'carol')).manifest;
  const table = (await harbor.fetchRelease('ar', 'carol')).content.trim().split(String.fromCharCode(10)).map(JSON.parse);
  const byId = new Map();
  for (const row of table) {
    // reconstruct cell coordinates to compare against manifest ordering
    byId.set(`${row.level}:${row.age_band ?? ''}:${row.district ?? ''}`, row);
  }
  // Every published ancestor must not contain exactly one suppressed non-empty descendant.
  const isAncestor = (ancestor, cell) => ancestor.level < cell.level &&
    (ancestor.age_band === null || ancestor.age_band === cell.age_band) &&
    (ancestor.district === null || ancestor.district === cell.district);
  for (const ancestor of table.filter(row => row.state === 'published')) {
    const descendants = table.filter(cell => isAncestor(ancestor, cell) && cell.state !== 'no_records');
    const hidden = descendants.filter(cell => cell.state === 'suppressed');
    assert.ok(hidden.length === 0 || hidden.length >= 2,
      `published ancestor exposes exactly one hidden cell: ${JSON.stringify(ancestor)}`);
  }
  assert.ok(manifest.suppression.complementaryCells > 0);
});

test('suppression reasons are visible but never contain real subject counts', async t => {
  const {harbor} = await aggregateSetup(t, fixtureRows());
  await approvedAggregate(harbor);
  const released = await harbor.release({id: 'ar', request: 'aq'}, 'alice');
  const reasonsJson = JSON.stringify(released.manifest.suppression);
  assert.ok(reasonsJson.includes('small_sample'));
  assert.ok(reasonsJson.includes('complementary'));
  for (const entry of released.manifest.suppression.reasons) {
    for (const item of entry.entries) {
      assert.equal(Object.hasOwn(item, 'subjectCount'), false);
      assert.equal(Object.hasOwn(item, 'count'), false);
      assert.equal(typeof item.threshold, 'number');
    }
  }
});

test('aggregate requests cannot reference columns outside the grant', async t => {
  const {harbor} = await aggregateSetup(t, fixtureRows());
  await harbor.grant(grant({columns: ['event_id', 'person', 'age_band', 'district'],
    transforms: {person: {kind: 'tokenize'}}}), 'alice');
  await assert.rejects(harbor.request(aggregateRequest(), 'carol'), kind('grant_columns'));
  await assert.rejects(harbor.request(aggregateRequest({
    aggregate: {groupBy: ['hours'], subjectKey: 'person',
      measures: [{name: 'users', operation: 'count'}]}}), 'carol'), kind('grant_columns'));
});

test('aggregate requires a small-sample threshold of at least two', async t => {
  const {harbor} = await aggregateSetup(t, fixtureRows());
  await harbor.grant(grant({minimumGroup: 1}), 'alice');
  await assert.rejects(harbor.request(aggregateRequest(), 'carol'), kind('minimum_group'));
});

test('aggregate proposal rejects an over-broad cube and a redacted or missing subject key', async t => {
  const {harbor} = await aggregateSetup(t, fixtureRows());
  await harbor.grant(grant(), 'alice');
  const tooManyCells = aggregateRequest({aggregate: {
    groupBy: ['age_band', 'district'], subjectKey: 'person',
    measures: [{name: 'users', operation: 'count'}], totals: true, maximumCells: 3}});
  await assert.rejects(harbor.request(tooManyCells, 'carol'), kind('aggregate_scope'));
  await assert.rejects(harbor.request(aggregateRequest({aggregate: {
    groupBy: ['age_band', 'district'], subjectKey: 'event_id',
    measures: [{name: 'users', operation: 'count'}]}}), 'carol'), kind('subject_key'));
  await harbor.grant({...grant(), id: 'g2', transforms: {person: {kind: 'redact'}}}, 'alice');
  await assert.rejects(harbor.request(aggregateRequest({id: 'aq2', grant: 'g2'}), 'carol'), kind('subject_key'));
});

test('aggregate requires a distinct-subject count measure', async t => {
  const {harbor} = await aggregateSetup(t, fixtureRows());
  await harbor.grant(grant(), 'alice');
  await assert.rejects(harbor.request(aggregateRequest({aggregate: {
    groupBy: ['district'], subjectKey: 'person',
    measures: [{name: 'total_hours', operation: 'sum', source: 'hours'}]}}), 'carol'), kind('measure_count'));
});

test('all-suppressed cubes reserve nothing and are rejected', async t => {
  const rows = [
    {event_id: 'e1', person: 'p1', age_band: '18-30', district: 'delta', hours: 1},
    {event_id: 'e2', person: 'p2', age_band: '31-50', district: 'hill', hours: 2},
  ];
  const {harbor} = await aggregateSetup(t, rows);
  await harbor.grant(grant({releaseLimit: 5}), 'alice');
  await assert.rejects(harbor.request(aggregateRequest({aggregate: {
    groupBy: ['age_band', 'district'], subjectKey: 'person',
    measures: [{name: 'users', operation: 'count'}], totals: false}}), 'carol'), kind('empty_release'));
  const budget = await harbor.budget('g');
  assert.equal(budget.reservedReleases, 0);
});

test('aggregate reserves release slots but no row budget, and releases spend only a slot', async t => {
  const {harbor} = await aggregateSetup(t, fixtureRows());
  await harbor.grant(grant({rowBudget: 3, releaseLimit: 3}), 'alice');
  await harbor.request(aggregateRequest(), 'carol');
  const reserved = await harbor.budget('g');
  assert.equal(reserved.reservedRows, 0);
  assert.equal(reserved.reservedReleases, 1);
  await harbor.decide({id: 'aq', decision: 'approve', reason: 'ok'}, 'alice');
  await harbor.decide({id: 'aq', decision: 'approve', reason: 'ok'}, 'bob');
  await harbor.release({id: 'ar', request: 'aq'}, 'alice');
  const spent = await harbor.budget('g');
  assert.equal(spent.spentRows, 0);
  assert.equal(spent.spentReleases, 1);
});

test('approval separation of duties and output-hash binding apply to aggregate requests', async t => {
  const {harbor} = await aggregateSetup(t, fixtureRows());
  await harbor.grant(grant(), 'alice');
  await harbor.request(aggregateRequest(), 'carol');
  await assert.rejects(harbor.decide({id: 'aq', decision: 'approve', reason: 'self'}, 'carol'), kind('steward'));
  await assert.rejects(harbor.release({id: 'ar', request: 'aq'}, 'alice'), kind('request_state'));
  await harbor.decide({id: 'aq', decision: 'approve', reason: 'ok'}, 'alice');
  await harbor.decide({id: 'aq', decision: 'approve', reason: 'ok'}, 'bob');
  assert.equal((await harbor.requestStatus('aq')).status, 'approved');
  const released = await harbor.release({id: 'ar', request: 'aq'}, 'alice');
  assert.equal(released.release.mode, 'aggregate');
});

test('re-generation rechecks approvals, policy hash and the locked aggregate specification', async t => {
  const {harbor} = await aggregateSetup(t, fixtureRows());
  await approvedAggregate(harbor);
  // Tamper with the persisted, approved aggregate specification inside a real commit.
  await harbor.vault.update('alice', 'test.tamper', async index => {
    index.requests.aq.aggregateHash = '0'.repeat(64);
    return {audit: {tampered: true}};
  });
  await assert.rejects(harbor.release({id: 'ar', request: 'aq'}, 'alice'), kind('aggregate_changed'));
  // A policy change after approval blocks regeneration through the policy-hash guard.
  await harbor.vault.update('alice', 'test.restore', async index => {
    index.requests.aq.aggregateHash = index.requests.aq.aggregateHash;
    index.grants.g.policyHash = '1'.repeat(64);
    return {audit: {policy: true}};
  });
  await assert.rejects(harbor.release({id: 'ar2', request: 'aq'}, 'alice'), kind('policy_changed'));
});

test('grant revocation and expiry invalidate aggregate download and proof', async t => {
  const {harbor, setTime} = await aggregateSetup(t, fixtureRows());
  await approvedAggregate(harbor);
  await harbor.release({id: 'ar', request: 'aq'}, 'alice');
  await harbor.revoke({id: 'g', reason: 'agreement ended'}, 'alice');
  await assert.rejects(harbor.fetchRelease('ar', 'carol'), kind('release_revoked'));
  await assert.rejects(harbor.proof('ar', 'carol'), kind('release_revoked'));
  const reissued = await aggregateSetup(t, fixtureRows());
  await approvedAggregate(reissued.harbor);
  await reissued.harbor.release({id: 'ar2', request: 'aq'}, 'alice');
  reissued.setTime('2026-11-21T00:00:00Z');
  await assert.rejects(reissued.harbor.fetchRelease('ar2', 'carol'), kind('release_expired'));
  await assert.rejects(reissued.harbor.proof('ar2', 'carol'), kind('release_expired'));
});

test('the aggregate release package contains only statistics, dimensions and audit metadata', async t => {
  const {harbor} = await aggregateSetup(t, fixtureRows());
  await approvedAggregate(harbor);
  const released = await harbor.release({id: 'ar', request: 'aq'}, 'alice');
  const fetched = await harbor.fetchRelease('ar', 'carol');
  for (const line of fetched.content.trim().split(String.fromCharCode(10))) {
    const row = JSON.parse(line);
    for (const keyName of Object.keys(row)) {
      assert.ok(['age_band', 'district', 'level', 'cell', 'state', 'users', 'total_hours'].includes(keyName),
        `unexpected raw column ${keyName}`);
    }
  }
  assert.ok(!fetched.content.includes('event_id'));
  assert.ok(!fetched.content.toLowerCase().includes('p1'));
  assert.equal(released.manifest.purpose, 'research');
  assert.equal(released.manifest.recipient, 'partner');
  assert.ok(Array.isArray(released.manifest.approvals));
});

test('row-level delivery still works alongside aggregate delivery on the same grant', async t => {
  const {harbor} = await aggregateSetup(t, fixtureRows());
  await harbor.grant(grant({minimumGroup: 2, quasiIdentifiers: ['district'], approvalCount: 1}), 'alice');
  await harbor.request(aggregateRequest({id: 'agg'}), 'carol');
  await harbor.decide({id: 'agg', decision: 'approve', reason: 'ok'}, 'alice');
  const aggregateRelease = await harbor.release({id: 'arr', request: 'agg'}, 'alice');
  assert.equal(aggregateRelease.release.mode, 'aggregate');
  await harbor.request({id: 'row', grant: 'g', reference: 'events:1', recipient: 'partner', purpose: 'research',
    columns: ['district', 'hours'], expiresAt: '2026-11-20T00:00:00Z'}, 'carol');
  await harbor.decide({id: 'row', decision: 'approve', reason: 'ok'}, 'bob');
  const rowRelease = await harbor.release({id: 'rlr', request: 'row'}, 'alice');
  assert.equal(rowRelease.release.mode, 'row');
  const fetched = await harbor.fetchRelease('rlr', 'carol');
  assert.ok(fetched.content.includes('"district"'));
  assert.equal((await harbor.verify()).valid, true);
});

test('aggregateSpec validates grouping, totals and measure shapes deterministically', () => {
  const version = {schema: {columns: [
    {name: 'person', type: 'string'}, {name: 'district', type: 'string'}, {name: 'hours', type: 'integer'},
  ]}};
  const grant = {columns: ['person', 'district', 'hours'], transforms: {person: {kind: 'tokenize'}}, minimumGroup: 2,
    recipient: 'partner', dataset: 'events', quasiIdentifiers: []};
  const spec = aggregateSpec({groupBy: ['district'], subjectKey: 'person',
    measures: [{name: 'n', operation: 'count'}], totals: true}, version, grant);
  assert.deepEqual(spec.totals, [[]]);
  assert.throws(() => aggregateSpec({groupBy: ['district', 'unknown'], subjectKey: 'person',
    measures: [{name: 'n', operation: 'count'}]}, version, grant), kind('aggregate_column'));
  assert.throws(() => aggregateSpec({groupBy: ['district'], subjectKey: 'person',
    measures: [{name: 'n', operation: 'median'}]}, version, grant), kind('choice'));
  assert.throws(() => aggregateSpec({groupBy: ['district'], subjectKey: 'person',
    measures: [{name: 'n', operation: 'sum', source: 'district'}]}, version, grant), kind('aggregate_type'));
  assert.throws(() => aggregateSpec({groupBy: [], subjectKey: 'person',
    measures: [{name: 'n', operation: 'count'}]}, version, grant), kind('groupBy'));
});

test('filters applied to aggregates stay within the grant and run before subject deduplication', async t => {
  const {harbor} = await aggregateSetup(t, fixtureRows());
  await approvedAggregate(harbor, {filters: [{column: 'district', operator: 'eq', value: 'delta'}]});
  const released = await harbor.release({id: 'ar', request: 'aq'}, 'alice');
  const table = (await harbor.fetchRelease('ar', 'carol')).content.trim().split(String.fromCharCode(10)).map(JSON.parse);
  const total = table.find(row => row.cell === 'total');
  assert.equal(total.users, 3);
  assert.equal(released.manifest.cells < 12, true);
});

test('aggregate request, approval, release and retrieval work through the HTTP API', async t => {
  const {harbor} = await aggregateSetup(t, fixtureRows());
  await harbor.grant(grant(), 'alice');
  const server = await serve(harbor, {port: 0, token: 'synthetic-api-token'});
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = {authorization: 'Bearer synthetic-api-token', 'content-type': 'application/json'};
  const body = aggregateRequest();
  const proposed = await fetch(base + '/requests', {method: 'POST', headers: {...headers, 'x-actor': 'carol'}, body: JSON.stringify(body)});
  assert.equal(proposed.status, 200);
  assert.equal((await proposed.json()).request.mode, 'aggregate');
  for (const actor of ['alice', 'bob']) {
    const decision = await fetch(base + '/requests/decide', {method: 'POST', headers: {...headers, 'x-actor': actor},
      body: JSON.stringify({id: 'aq', decision: 'approve', reason: 'reviewed'})});
    assert.equal(decision.status, 200);
  }
  const released = await fetch(base + '/releases', {method: 'POST', headers: {...headers, 'x-actor': 'alice'},
    body: JSON.stringify({id: 'ar', request: 'aq'})});
  assert.equal(released.status, 200);
  assert.equal((await released.json()).release.mode, 'aggregate');
  const fetched = await fetch(base + '/release?id=ar', {headers: {authorization: 'Bearer synthetic-api-token', 'x-actor': 'carol'}});
  const document = await fetched.json();
  assert.equal(fetched.status, 200);
  const states = new Set(document.content.trim().split(String.fromCharCode(10)).map(line => JSON.parse(line).state));
  assert.ok([...states].every(state => ['published', 'suppressed', 'no_records', 'zero'].includes(state)));
  const status = await fetch(base + '/request?id=aq', {headers: {authorization: 'Bearer synthetic-api-token', 'x-actor': 'alice'}});
  assert.equal((await status.json()).mode, 'aggregate');
});
