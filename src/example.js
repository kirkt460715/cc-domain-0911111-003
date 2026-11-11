import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Harbor} from './service.js';
const root = await mkdtemp(path.join(os.tmpdir(), 'harbor-example-'));
try {
  const harbor = new Harbor(root, {clock: () => new Date('2026-11-01T00:00:00Z')});
  await harbor.organization({id: 'local', name: 'Synthetic local institute', region: 'south',
    purposes: ['research'], stewards: ['alice', 'bob']}, 'bootstrap');
  await harbor.organization({id: 'partner', name: 'Synthetic training partner', region: 'south',
    purposes: ['research'], stewards: ['carol']}, 'bootstrap');
  await harbor.dataset({id: 'training', name: 'Synthetic course participation', owner: 'local', schema: {
    columns: [
      {name: 'person', type: 'string', classification: 'sensitive'},
      {name: 'district', type: 'string', classification: 'public'},
      {name: 'hours', type: 'integer', classification: 'public', minimum: 0},
    ], primaryKey: ['person'],
  }}, 'alice');
  const imported = await harbor.import({dataset: 'training', importId: 'first', rows: [
    {person: 'synthetic-a', district: 'delta', hours: 12},
    {person: 'synthetic-b', district: 'delta', hours: 20},
    {person: 'synthetic-c', district: 'hill', hours: 8},
  ]}, 'alice');
  assert.equal(imported.version.status, 'validated');
  await harbor.activate({dataset: 'training', version: 1}, 'alice');
  await harbor.grant({id: 'research', dataset: 'training', recipient: 'partner', purposes: ['research'],
    columns: ['person', 'district', 'hours'], transforms: {person: {kind: 'tokenize'}},
    rowBudget: 10, expiresAt: '2026-12-01T00:00:00Z', minimumGroup: 2, quasiIdentifiers: ['district'], approvalCount: 2}, 'alice');
  const request = await harbor.request({id: 'delivery', grant: 'research', reference: 'training:1', recipient: 'partner',
    purpose: 'research', columns: ['person', 'district', 'hours'], expiresAt: '2026-11-20T00:00:00Z'}, 'carol');
  assert.equal(request.request.outputRows, 2);
  assert.equal(request.request.disclosure.suppressedRows, 1);
  await harbor.decide({id: 'delivery', decision: 'approve', reason: 'purpose reviewed'}, 'alice');
  await harbor.decide({id: 'delivery', decision: 'approve', reason: 'disclosure reviewed'}, 'bob');
  const released = await harbor.release({id: 'package', request: 'delivery'}, 'alice');
  assert.equal(released.release.rows, 2);
  const fetched = await harbor.fetchRelease('package', 'carol');
  assert.equal(fetched.content.includes('synthetic-a'), false);
  assert.equal((await harbor.budget('research')).spentRows, 2);
  assert.equal((await harbor.proof('package', 'carol')).artifactVerified, true);
  await harbor.revoke({id: 'research', reason: 'synthetic agreement ended'}, 'alice');
  await assert.rejects(harbor.fetchRelease('package', 'carol'), error => error.kind === 'release_revoked');

  await harbor.dataset({id: 'service', name: 'Synthetic service usage', owner: 'local', schema: {
    columns: [
      {name: 'event_id', type: 'string', classification: 'public'},
      {name: 'person', type: 'string', classification: 'sensitive'},
      {name: 'age_band', type: 'string', classification: 'public'},
      {name: 'district', type: 'string', classification: 'public'},
      {name: 'hours', type: 'integer', classification: 'public', minimum: 0},
    ], primaryKey: ['event_id'],
  }}, 'alice');
  await harbor.import({dataset: 'service', importId: 'first', rows: [
    {event_id: 's1', person: 'u1', age_band: '18-30', district: 'delta', hours: 4},
    {event_id: 's2', person: 'u1', age_band: '18-30', district: 'delta', hours: 6},
    {event_id: 's3', person: 'u2', age_band: '18-30', district: 'delta', hours: 8},
    {event_id: 's4', person: 'u3', age_band: '31-50', district: 'delta', hours: 5},
    {event_id: 's5', person: 'u4', age_band: '31-50', district: 'hill', hours: 7},
    {event_id: 's6', person: 'u5', age_band: '51+', district: 'hill', hours: 9},
  ]}, 'alice');
  await harbor.activate({dataset: 'service', version: 1}, 'alice');
  await harbor.grant({id: 'stats', dataset: 'service', recipient: 'partner', purposes: ['research'],
    columns: ['event_id', 'person', 'age_band', 'district', 'hours'], transforms: {person: {kind: 'tokenize'}},
    rowBudget: 100, releaseLimit: 10, expiresAt: '2026-12-01T00:00:00Z',
    minimumGroup: 2, quasiIdentifiers: ['district'], approvalCount: 2}, 'alice');
  const aggregate = await harbor.request({id: 'age-question', grant: 'stats', reference: 'service:1',
    recipient: 'partner', purpose: 'research', mode: 'aggregate', expiresAt: '2026-11-20T00:00:00Z',
    aggregate: {groupBy: ['age_band', 'district'], subjectKey: 'person',
      measures: [{name: 'users', operation: 'count'}, {name: 'hours_total', operation: 'sum', source: 'hours'}],
      totals: true}}, 'carol');
  assert.equal(aggregate.request.disclosure.emptySubjectRows, 0);
  assert.ok(aggregate.request.disclosure.suppressedCells > 0);
  await harbor.decide({id: 'age-question', decision: 'approve', reason: 'purpose reviewed'}, 'alice');
  await harbor.decide({id: 'age-question', decision: 'approve', reason: 'suppression reviewed'}, 'bob');
  const statistics = await harbor.release({id: 'age-package', request: 'age-question'}, 'alice');
  assert.equal(statistics.release.mode, 'aggregate');
  assert.equal(statistics.manifest.rows, 0);
  const delivered = await harbor.fetchRelease('age-package', 'carol');
  const cells = delivered.content.trim().split(String.fromCharCode(10)).map(JSON.parse);
  assert.ok(cells.every(row => ['published', 'suppressed', 'no_records', 'zero'].includes(row.state)));
  assert.ok(cells.some(row => row.state === 'suppressed' && row.users === null));
  assert.equal(delivered.content.includes('u1'), false);
  await harbor.revoke({id: 'stats', reason: 'synthetic statistics agreement ended'}, 'alice');
  await assert.rejects(harbor.proof('age-package', 'carol'), error => error.kind === 'release_revoked');

  assert.equal((await harbor.verify()).valid, true);
  process.stdout.write(JSON.stringify({accepted: true, offline: true, status: await harbor.status()}) + String.fromCharCode(10));
} finally {
  await rm(root, {recursive: true, force: true});
}
