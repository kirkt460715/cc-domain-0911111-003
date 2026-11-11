import {fields, key, label, list, distinct, select, instant, demand, found, checksum} from './primitives.js';
import {assertGrant, requireBudget, requireAggregateBudget} from './policy.js';
import {requireSteward} from './registry.js';
import {buildDisclosure} from './disclosure.js';
import {aggregateSpec, buildAggregate} from './aggregate.js';

export async function proposeRequest(vault, index, input, actor, at) {
  fields(input, ['id', 'grant', 'reference', 'recipient', 'purpose', 'columns', 'filters', 'format', 'expiresAt', 'mode', 'aggregate'],
    ['id', 'grant', 'reference', 'recipient', 'purpose', 'expiresAt']);
  const id = key(input.id);
  const fingerprint = checksum(input);
  const existing = index.requests[id];
  if (existing) {
    demand(existing.inputHash === fingerprint && existing.requestedBy === actor, 'request_conflict', 'Request id already has different content');
    return {noChange: true, result: {request: existing, replay: true}};
  }
  const grant = found(index.grants, key(input.grant), 'Grant');
  const recipient = found(index.organizations, key(input.recipient), 'Recipient');
  requireSteward(index, recipient.id, actor);
  const mode = select(input.mode ?? 'row', ['row', 'aggregate'], 'mode');
  const expiresAt = instant(input.expiresAt, 'expiresAt');
  const base = {
    id,
    grant: grant.id,
    reference: input.reference,
    recipient: recipient.id,
    purpose: key(input.purpose),
    filters: input.filters ?? [],
    format: select(input.format ?? 'jsonl', ['jsonl', 'json', 'csv'], 'format'),
    expiresAt,
    requestedBy: key(actor),
    requestedAt: at,
    inputHash: fingerprint,
    status: 'pending',
    approvals: [],
    policyHash: grant.policyHash,
    mode,
  };
  demand(base.expiresAt > at && base.expiresAt <= grant.expiresAt, 'request_expiry', 'Request expiry must fit the grant');
  if (mode === 'aggregate') {
    return proposeAggregate(vault, index, base, input, grant, at);
  }
  return proposeRow(vault, index, base, input, grant);
}

async function proposeRow(vault, index, request, input, grant) {
  const columns = distinct(list(input.columns, 'columns', 200).map(value => key(value)), 'columns');
  Object.assign(request, {columns, aggregate: null});
  const version = assertGrant(index, grant, request, request.requestedAt);
  const rows = await vault.getRows(version.object);
  const secret = await vault.secret();
  const disclosure = buildDisclosure(rows, version, grant, request, secret);
  demand(disclosure.rows.length > 0, 'empty_release', 'No rows survive disclosure rules');
  requireBudget(index, grant.id, disclosure.rows.length);
  Object.assign(request, {
    outputRows: disclosure.rows.length,
    outputHash: disclosure.fingerprint,
    disclosure: disclosure.report,
    filters: disclosure.filters,
    versionObject: version.object,
    schemaHash: version.schemaHash,
  });
  index.requests[request.id] = request;
  return {result: {request, replay: false}, audit: {request: request.id, reservedRows: request.outputRows, grant: grant.id}};
}

async function proposeAggregate(vault, index, request, input, grant, at) {
  demand(input.columns === undefined, 'aggregate_columns', 'Aggregate requests select dimensions and measures, not row columns');
  const version = usableVersionForPreview(index, request);
  const aggregate = aggregateSpec(input.aggregate, version, grant);
  Object.assign(request, {columns: null, aggregate});
  assertGrant(index, grant, request, at);
  const rows = await vault.getRows(version.object);
  const secret = await vault.secret();
  const result = buildAggregate(rows, version, grant, request, secret);
  demand(result.report.publishedCells > 0, 'empty_release', 'Every aggregate cell is suppressed; nothing can be published');
  requireAggregateBudget(index, grant.id);
  Object.assign(request, {
    outputRows: 0,
    outputHash: result.fingerprint,
    disclosure: result.report,
    filters: result.filters,
    versionObject: version.object,
    schemaHash: version.schemaHash,
    aggregateHash: checksum(aggregate),
  });
  index.requests[request.id] = request;
  return {result: {request, replay: false},
    audit: {request: request.id, grant: grant.id, mode: 'aggregate', cells: result.report.cells,
      suppressed: result.report.suppressedCells}};
}

function usableVersionForPreview(index, request) {
  const version = found(index.versions, request.reference, 'Version');
  demand(version.status === 'active', 'version_unavailable', 'Version is not active', {reference: version.reference});
  for (const dependency of version.dependencies) {
    const parent = found(index.versions, dependency, 'Version');
    demand(parent.status === 'active', 'dependency_unavailable', 'Version dependency is no longer active', {dependency});
  }
  return version;
}
export function decideRequest(index, input, actor, at) {
  fields(input, ['id', 'decision', 'reason'], ['id', 'decision', 'reason']);
  const request = found(index.requests, key(input.id), 'Request');
  const grant = found(index.grants, request.grant, 'Grant');
  requireSteward(index, grant.owner, actor);
  demand(actor !== request.requestedBy, 'separation', 'Requester cannot approve their own request');
  demand(request.status === 'pending', 'request_state', 'Request is not pending');
  demand(at < request.expiresAt, 'request_expired', 'Request has expired');
  assertGrant(index, grant, request, at);
  const decision = select(input.decision, ['approve', 'reject'], 'decision');
  const reason = label(input.reason, 'reason', 1000);
  if (decision === 'reject') {
    request.status = 'rejected';
    request.rejection = {actor, reason, at};
  } else {
    demand(!request.approvals.some(approval => approval.actor === actor), 'approval_duplicate', 'Steward has already approved');
    request.approvals.push({actor, reason, at, policyHash: grant.policyHash, outputHash: request.outputHash});
    if (request.approvals.length >= grant.approvalCount) {
      request.status = 'approved';
    }
  }
  return {result: {request}, audit: {request: request.id, decision, status: request.status}};
}
export function cancelRequest(index, input, actor) {
  fields(input, ['id', 'reason'], ['id', 'reason']);
  const request = found(index.requests, key(input.id), 'Request');
  demand(actor === request.requestedBy || index.organizations[index.grants[request.grant].owner].stewards.includes(actor),
    'cancel_actor', 'Only requester or owner steward can cancel', {}, 403);
  demand(['pending', 'approved'].includes(request.status), 'request_state', 'Request can no longer be cancelled');
  request.status = 'cancelled';
  request.cancellation = {actor, reason: label(input.reason, 'reason', 1000)};
  return {result: {request}, audit: {request: request.id, releasedReservation: request.outputRows}};
}
export function expireRequests(index, at) {
  const expired = [];
  for (const request of Object.values(index.requests)) {
    if (['pending', 'approved'].includes(request.status) && request.expiresAt <= at) {
      request.status = 'expired';
      expired.push(request.id);
    }
  }
  return {noChange: expired.length === 0, result: {expired}, audit: {expired}};
}
export function requestSummary(index, id) {
  const request = found(index.requests, key(id), 'Request');
  const grant = index.grants[request.grant];
  const summary = {
    id: request.id,
    mode: request.mode ?? 'row',
    status: request.status,
    recipient: request.recipient,
    reference: request.reference,
    purpose: request.purpose,
    outputRows: request.outputRows,
    approvalCount: request.approvals.length,
    requiredApprovals: grant.approvalCount,
    expiresAt: request.expiresAt,
    outputHash: request.outputHash,
    policyHash: request.policyHash,
    release: request.release ?? null,
  };
  if (summary.mode === 'aggregate') {
    summary.aggregate = request.aggregate;
    summary.publishedCells = request.disclosure.publishedCells;
    summary.suppressedCells = request.disclosure.suppressedCells;
    summary.noRecordCells = request.disclosure.noRecordCells;
    summary.zeroCells = request.disclosure.zeroCells;
  }
  return summary;
}
