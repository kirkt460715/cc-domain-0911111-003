import {fields, key, label, demand, found, checksum} from './primitives.js';
import {assertGrant, requireBudget, requireAggregateBudget} from './policy.js';
import {requireSteward, usableVersion} from './registry.js';
import {buildDisclosure} from './disclosure.js';
import {buildAggregate, aggregateTable} from './aggregate.js';
import {writeTable} from './tabular.js';

export async function materializeRelease(vault, index, input, actor, at) {
  fields(input, ['id', 'request'], ['id', 'request']);
  const id = key(input.id);
  const request = found(index.requests, key(input.request), 'Request');
  const grant = found(index.grants, request.grant, 'Grant');
  requireSteward(index, grant.owner, actor);
  if (index.releases[id]) {
    const previous = index.releases[id];
    demand(previous.request === request.id && previous.status === 'available', 'release_conflict', 'Release id is already occupied');
    await readableRelease(vault, index, id, at);
    return {noChange: true, result: {release: previous, replay: true}};
  }
  demand(request.status === 'approved', 'request_state', 'Release requires an approved request');
  demand(at < request.expiresAt, 'request_expired', 'Approved request expired before release');
  demand(request.policyHash === grant.policyHash, 'policy_changed', 'Approved policy changed');
  const version = assertGrant(index, grant, request, at);
  demand(version.object === request.versionObject && version.schemaHash === request.schemaHash,
    'version_changed', 'Approved data object changed');
  demand(request.approvals.length >= grant.approvalCount, 'approval_quorum', 'Approval quorum is incomplete');
  demand(new Set(request.approvals.map(item => item.actor)).size === request.approvals.length,
    'approval_duplicate', 'Approval identities are not distinct');
  for (const approval of request.approvals) {
    requireSteward(index, grant.owner, approval.actor);
    demand(approval.actor !== request.requestedBy && approval.policyHash === grant.policyHash && approval.outputHash === request.outputHash,
      'approval_binding', 'Approval does not match the current request');
  }
  const rows = await vault.getRows(version.object);
  const secret = await vault.secret();
  if ((request.mode ?? 'row') === 'aggregate') {
    return materializeAggregate(vault, index, {id, request, grant, version, rows, secret, at});
  }
  const disclosure = buildDisclosure(rows, version, grant, request, secret);
  demand(disclosure.fingerprint === request.outputHash && disclosure.rows.length === request.outputRows,
    'disclosure_changed', 'Disclosure output differs from approved preview');
  requireBudget(index, grant.id, request.outputRows, request.id);
  const content = writeTable(disclosure.rows, request.columns, request.format);
  const artifact = await vault.putObject(content);
  const manifest = {
    formatVersion: 1,
    id,
    request: request.id,
    mode: 'row',
    dataset: version.dataset,
    reference: version.reference,
    sourceObject: version.object,
    schemaHash: version.schemaHash,
    policyHash: grant.policyHash,
    recipient: request.recipient,
    purpose: request.purpose,
    columns: request.columns,
    format: request.format,
    rows: disclosure.rows.length,
    cells: null,
    bytes: artifact.bytes,
    checksum: artifact.hash,
    outputHash: disclosure.fingerprint,
    dependencies: version.dependencies,
    expiresAt: request.expiresAt,
    createdAt: at,
    approvals: request.approvals.map(approval => ({actor: approval.actor, at: approval.at})),
  };
  const manifestObject = await vault.putObject(manifest);
  const release = {
    id,
    request: request.id,
    grant: grant.id,
    reference: version.reference,
    mode: 'row',
    status: 'available',
    artifact: artifact.hash,
    manifest: manifestObject.hash,
    rows: disclosure.rows.length,
    recipient: request.recipient,
    expiresAt: request.expiresAt,
    createdAt: at,
  };
  index.releases[id] = release;
  request.status = 'released';
  request.release = id;
  grant.spentRows += release.rows;
  grant.spentReleases += 1;
  return {result: {release, manifest, replay: false}, audit: {release: id, rows: release.rows, artifact: artifact.hash}};
}

async function materializeAggregate(vault, index, {id, request, grant, version, rows, secret, at}) {
  const aggregate = buildAggregate(rows, version, grant, request, secret);
  demand(aggregate.fingerprint === request.outputHash, 'disclosure_changed',
    'Aggregate output differs from the approved preview');
  demand(checksum(aggregate.spec) === request.aggregateHash, 'aggregate_changed',
    'Aggregate specification changed after approval');
  requireAggregateBudget(index, grant.id, request.id);
  const table = aggregateTable(aggregate.records, aggregate.spec);
  const content = writeTable(table, aggregate.report.columns, request.format);
  const artifact = await vault.putObject(content);
  const manifest = {
    formatVersion: 1,
    id,
    request: request.id,
    mode: 'aggregate',
    dataset: version.dataset,
    reference: version.reference,
    sourceObject: version.object,
    schemaHash: version.schemaHash,
    policyHash: grant.policyHash,
    recipient: request.recipient,
    purpose: request.purpose,
    columns: aggregate.report.columns,
    aggregate: request.aggregate,
    aggregateHash: request.aggregateHash,
    format: request.format,
    rows: 0,
    cells: aggregate.report.cells,
    publishedCells: aggregate.report.publishedCells,
    suppressedCells: aggregate.report.suppressedCells,
    noRecordCells: aggregate.report.noRecordCells,
    zeroCells: aggregate.report.zeroCells,
    suppression: aggregate.report.suppression,
    bytes: artifact.bytes,
    checksum: artifact.hash,
    outputHash: aggregate.fingerprint,
    dependencies: version.dependencies,
    expiresAt: request.expiresAt,
    createdAt: at,
    approvals: request.approvals.map(approval => ({actor: approval.actor, at: approval.at})),
  };
  const manifestObject = await vault.putObject(manifest);
  const release = {
    id,
    request: request.id,
    grant: grant.id,
    reference: version.reference,
    mode: 'aggregate',
    status: 'available',
    artifact: artifact.hash,
    manifest: manifestObject.hash,
    rows: 0,
    cells: aggregate.report.cells,
    recipient: request.recipient,
    expiresAt: request.expiresAt,
    createdAt: at,
  };
  index.releases[id] = release;
  request.status = 'released';
  request.release = id;
  grant.spentReleases += 1;
  return {result: {release, manifest, replay: false},
    audit: {release: id, mode: 'aggregate', cells: release.cells, artifact: artifact.hash}};
}
export async function readableRelease(vault, index, id, at) {
  const release = found(index.releases, key(id), 'Release');
  demand(release.status === 'available', 'release_revoked', 'Release has been withdrawn', {id}, 410);
  demand(at < release.expiresAt, 'release_expired', 'Release has expired', {id}, 410);
  const request = found(index.requests, release.request, 'Request');
  const grant = found(index.grants, release.grant, 'Grant');
  assertGrant(index, grant, request, at);
  usableVersion(index, release.reference);
  const manifest = JSON.parse(await vault.getObject(release.manifest));
  const content = await vault.getObject(release.artifact);
  demand(checksum(content) === manifest.checksum && manifest.checksum === release.artifact,
    'release_checksum', 'Artifact differs from manifest');
  demand(manifest.request === request.id && manifest.policyHash === request.policyHash && manifest.rows === release.rows,
    'release_binding', 'Release manifest binding is invalid');
  return {release, manifest, content};
}
export function withdrawRelease(index, input, actor, at) {
  fields(input, ['id', 'reason'], ['id', 'reason']);
  const release = found(index.releases, key(input.id), 'Release');
  const grant = found(index.grants, release.grant, 'Grant');
  requireSteward(index, grant.owner, actor);
  if (release.status === 'withdrawn') {
    return {noChange: true, result: {release}};
  }
  release.status = 'withdrawn';
  release.withdrawal = {actor, at, reason: label(input.reason, 'reason', 1000)};
  return {result: {release}, audit: {release: release.id, reason: release.withdrawal.reason, budgetRefunded: false}};
}
export async function releaseProof(vault, index, id, at) {
  const {release, manifest, content} = await readableRelease(vault, index, id, at);
  const proof = {
    id: release.id,
    mode: manifest.mode,
    artifactVerified: checksum(content) === release.artifact,
    manifestVerified: checksum(manifest) === release.manifest,
    bytes: Buffer.byteLength(content),
    rows: manifest.rows,
    sourceObject: manifest.sourceObject,
    policyHash: manifest.policyHash,
    approvals: manifest.approvals,
    validUntil: manifest.expiresAt,
  };
  if (manifest.mode === 'aggregate') {
    proof.cells = manifest.cells;
    proof.publishedCells = manifest.publishedCells;
    proof.suppressedCells = manifest.suppressedCells;
    proof.noRecordCells = manifest.noRecordCells;
    proof.zeroCells = manifest.zeroCells;
    proof.suppressionRules = [...new Set(manifest.suppression.reasons.flatMap(entry =>
      entry.entries.map(item => item.rule)))];
    proof.aggregateHash = manifest.aggregateHash;
  }
  return proof;
}
