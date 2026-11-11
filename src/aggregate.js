import {fields, key, list, distinct, select, count, demand, encode, checksum} from './primitives.js';
import {filterSpec, matches, protectValue} from './disclosure.js';

export const AGGREGATE_OPERATIONS = ['count', 'sum', 'mean', 'min', 'max'];
export const MAX_GROUP_DIMENSIONS = 4;
export const MAX_AGGREGATE_CELLS = 5000;
const RESERVED_CELL_COLUMNS = new Set(['level', 'cell', 'state']);
const GENERALIZED_TRANSFORMS = new Set(['keep', 'bucket', 'prefix', 'date_floor']);

function numericColumn(version, name) {
  const column = version.schema.columns.find(item => item.name === name);
  demand(column, 'aggregate_column', 'Aggregate column is absent from the pinned version', {column: name});
  demand(['integer', 'number'].includes(column.type), 'aggregate_type', 'Numeric aggregate requires a numeric column', {column: name});
  return column;
}

export function aggregateSpec(input, version, grant) {
  fields(input, ['groupBy', 'subjectKey', 'measures', 'totals', 'maximumCells'],
    ['groupBy', 'subjectKey', 'measures']);
  const groupBy = distinct(list(input.groupBy, 'groupBy', MAX_GROUP_DIMENSIONS).map(value => key(value, 'groupBy')), 'groupBy');
  demand(groupBy.length > 0 && groupBy.length <= MAX_GROUP_DIMENSIONS, 'groupBy', 'groupBy needs one to four dimensions');
  const subjectKey = key(input.subjectKey, 'subjectKey');
  const maximumCells = count(input.maximumCells ?? MAX_AGGREGATE_CELLS, 'maximumCells', 1, MAX_AGGREGATE_CELLS);
  const known = new Set(version.schema.columns.map(column => column.name));
  for (const name of [...groupBy, subjectKey]) {
    demand(known.has(name), 'aggregate_column', 'Aggregate references an unknown column', {column: name});
    demand(grant.columns.includes(name), 'grant_columns', 'Aggregate column is outside the grant', {column: name});

  }
  const subjectDefinition = version.schema.columns.find(item => item.name === subjectKey);
  const subjectAction = grant.transforms[subjectKey] ?? {kind: 'keep'};
  demand(['keep', 'tokenize'].includes(subjectAction.kind), 'subject_key',
    'Subject key must be kept or tokenized, never redacted', {column: subjectKey});
  const isPrimaryKey = (version.schema.primaryKey ?? []).includes(subjectKey);
  demand(!isPrimaryKey || subjectAction.kind === 'tokenize', 'subject_key',
    'A primary-key subject must be tokenized so distinct counting does not equate to row counting', {column: subjectKey});
  if (subjectAction.kind === 'keep') {
    demand(['sensitive', 'restricted'].includes(subjectDefinition.classification), 'subject_key',
      'A kept subject key must identify a sensitive subject, not an opaque row identifier', {column: subjectKey});
  }
  demand(grant.minimumGroup >= 2, 'minimum_group',
    'Aggregate delivery requires a grant small-sample threshold of at least two', {minimumGroup: grant.minimumGroup});
  for (const name of groupBy) {
    const action = grant.transforms[name] ?? {kind: 'keep'};
    demand(GENERALIZED_TRANSFORMS.has(action.kind), 'group_transform',
    'Grouping dimensions must be kept or generalized with bucket, prefix or date_floor', {column: name});
  }
  const measures = list(input.measures, 'measures', 50).map(measure => {
    fields(measure, ['name', 'operation', 'source'], ['name', 'operation']);
    const name = key(measure.name, 'measure name');
    demand(!RESERVED_CELL_COLUMNS.has(name) && !groupBy.includes(name) && name !== subjectKey,
      'measure_name', 'Measure name collides with a dimension or reserved column');
    const operation = select(measure.operation, AGGREGATE_OPERATIONS, 'aggregate operation');
    let source = null;
    if (operation === 'count') {
      demand(measure.source === undefined || measure.source === null, 'measure_source', 'count measure takes no source column');
    } else {
      source = key(measure.source, 'measure source');
      demand(known.has(source) && grant.columns.includes(source), 'grant_columns',
        'Measure source is outside the grant or unknown', {column: source});
      demand((grant.transforms[source] ?? {kind: 'keep'}).kind === 'keep', 'measure_transform',
        'Numeric measures require an untransformed source column', {column: source});
      numericColumn(version, source);
    }
    return {name, operation, source};
  });
  distinct(measures.map(measure => measure.name), 'measure names');
  demand(measures.length > 0, 'measures', 'Aggregate requires at least one measure');
  demand(measures.some(measure => measure.operation === 'count'), 'measure_count',
    'Aggregate requires a distinct-subject count measure');
  let totals;
  if (input.totals === true) {
    totals = rollupSubsets(groupBy);
  } else if (input.totals === false || input.totals === undefined) {
    totals = input.totals === false ? [] : [[]];
  } else {
    demand(Array.isArray(input.totals), 'totals', 'totals must be true, false or a list of dimension subsets');
    const chosen = new Set();
    for (const entry of list(input.totals, 'totals', 20)) {
      const fixed = distinct(list(entry, 'totals entry', MAX_GROUP_DIMENSIONS).map(value => key(value)), 'totals entry');
      demand(fixed.every(name => groupBy.includes(name)), 'totals', 'Totals entry names an unknown grouping dimension');
      demand(fixed.length < groupBy.length, 'totals', 'Totals entry cannot repeat the full grouping (that is a leaf cell)');
      chosen.add(encode(groupBy.filter(name => fixed.includes(name))));
    }
    chosen.add(encode([]));
    totals = [...chosen].map(value => JSON.parse(value));
  }
  return {groupBy, subjectKey, measures, totals, maximumCells};
}

function rollupSubsets(groupBy) {
  const subsets = [[]];
  for (let mask = 1; mask < (1 << groupBy.length) - 1; mask += 1) {
    subsets.push(groupBy.filter((_, position) => mask & (1 << position)));
  }
  return subsets;
}

function dimensionValue(row, name, grant, secret) {
  return protectValue(row[name], grant.transforms[name] ?? {kind: 'keep'}, secret,
    `${grant.recipient}:${grant.dataset}:${name}`);
}

function sortedValues(values) {
  return [...values].sort((a, b) => encode(a).localeCompare(encode(b)));
}

function combine(numericValues, operation) {
  if (operation === 'count') {
    return undefined;
  }
  const values = numericValues.filter(value => value !== null && value !== undefined);
  if (values.length === 0) {
    return null;
  }
  switch (operation) {
    case 'sum': {
      let sum = 0;
      let compensation = 0;
      for (const number of values) {
        const adjusted = number - compensation;
        const next = sum + adjusted;
        compensation = (next - sum) - adjusted;
        sum = next;
      }
      return sum;
    }
    case 'mean':
      return values.reduce((a, b) => a + b, 0) / values.length;
    case 'min':
      return values.reduce((a, b) => Math.min(a, b));
    case 'max':
      return values.reduce((a, b) => Math.max(a, b));
    default:
      demand(false, 'aggregate_operation', 'Unsupported aggregate operation');
  }
}

function product(domains) {
  let combos = [[]];
  for (const values of domains) {
    const next = [];
    for (const prefix of combos) {
      for (const value of values) {
        next.push([...prefix, value]);
      }
    }
    combos = next;
  }
  return combos;
}

export function buildAggregate(rows, version, grant, request, secret) {
  const spec = request.aggregate;
  const filters = filterSpec(request.filters, version.schema);
  for (const filter of filters) {
    const action = grant.transforms[filter.column] ?? {kind: 'keep'};
    demand(action.kind === 'keep' && grant.columns.includes(filter.column), 'filter_disclosure',
      'Aggregate filters may only use untransformed columns inside the grant');
  }
  const selected = rows.filter(row => matches(row, filters));
  let emptySubjectRows = 0;
  const subjectRows = [];
  for (const row of selected) {
    const identity = row[spec.subjectKey];
    if (identity === null || identity === undefined) {
      emptySubjectRows += 1;
      continue;
    }
    subjectRows.push(row);
  }
  const distinctSubjects = new Set(subjectRows.map(row => row[spec.subjectKey])).size;
  const domains = spec.groupBy.map(name => {
    const observed = new Set();
    for (const row of subjectRows) {
      observed.add(dimensionValue(row, name, grant, secret));
    }
    return sortedValues(observed);
  });
  const leafCombinations = product(domains);
  const leaves = new Map();
  for (const values of leafCombinations) {
    leaves.set(encode(values), {values, subjects: new Set(), reps: []});
  }
  for (const row of subjectRows) {
    const values = spec.groupBy.map(name => dimensionValue(row, name, grant, secret));
    const cell = leaves.get(encode(values));
    const identity = row[spec.subjectKey];
    cell.subjects.add(identity);
    cell.reps.push(row);
  }
  const cells = [];
  for (const leaf of leaves.values()) {
    cells.push(makeCell(spec, leaf.values, spec.groupBy.map(() => true), 'value', leaf));
  }
  for (const fixed of spec.totals) {
    const mask = spec.groupBy.map(name => fixed.includes(name));
    const grouped = new Map();
    for (const leaf of leaves.values()) {
      const keyValues = spec.groupBy.map((name, position) => mask[position] ? leaf.values[position] : null);
      const identity = encode(keyValues);
      if (!grouped.has(identity)) {
        grouped.set(identity, {values: keyValues, subjects: new Set(), reps: []});
      }
      const target = grouped.get(identity);
      for (const row of leaf.reps) {
        target.subjects.add(row[spec.subjectKey]);
        target.reps.push(row);
      }
    }
    for (const total of grouped.values()) {
      cells.push(makeCell(spec, total.values, mask, mask.every(present => !present) ? 'total' : 'subtotal', total));
    }
  }
  demand(cells.length <= spec.maximumCells, 'aggregate_scope',
    'Aggregate cube exceeds the publishable cell limit; narrow the grouping dimensions', {cells: cells.length, maximumCells: spec.maximumCells});
  cells.sort((a, b) => encode(a.coordinates).localeCompare(encode(b.coordinates)));
  cells.forEach((cell, index) => {
    cell.cellId = `c${index + 1}`;
  });
  const threshold = grant.minimumGroup;
  const reasons = new Map();
  const suppressed = new Set();
  for (const cell of cells) {
    if (cell.subjectCount > 0 && cell.subjectCount < threshold) {
      suppressed.add(cell.cellId);
      reasons.set(cell.cellId, [{rule: 'small_sample', threshold}]);
    }
  }
  const primaryCells = suppressed.size;
  const byId = new Map(cells.map(cell => [cell.cellId, cell]));
  const descendantsOf = ancestor => cells.filter(other => isAncestor(ancestor, other) && other.subjectCount > 0);
  let changed = true;
  let cycle = 0;
  while (changed) {
    changed = false;
    for (const sensitiveId of [...suppressed]) {
      for (const ancestor of cells) {
        if (suppressed.has(ancestor.cellId) || !isAncestor(ancestor, byId.get(sensitiveId))) {
          continue;
        }
        const hidden = descendantsOf(ancestor).filter(other => suppressed.has(other.cellId));
        if (hidden.length >= 2) {
          continue;
        }
        cycle += 1;
        const partners = descendantsOf(ancestor).filter(other => !suppressed.has(other.cellId));
        if (partners.length === 0) {
          suppressed.add(ancestor.cellId);
          reasons.set(ancestor.cellId, [{rule: 'complementary', threshold, cycle, partnerCell: sensitiveId}]);
          changed = true;
          continue;
        }
        partners.sort((a, b) => a.subjectCount - b.subjectCount || a.cellId.localeCompare(b.cellId));
        const partner = partners[0];
        suppressed.add(partner.cellId);
        reasons.set(partner.cellId, [{rule: 'complementary', threshold, cycle, partnerCell: sensitiveId}]);
        changed = true;
      }
    }
  }
  const records = [];
  const summary = {publishedCells: 0, suppressedCells: 0, noRecordCells: 0, zeroCells: 0};
  for (const cell of cells) {
    const isSuppressed = suppressed.has(cell.cellId);
    const record = {
      cellId: cell.cellId,
      level: cell.level,
      cell: cell.role,
      state: 'published',
      reasons: [],
      coordinates: cell.coordinates,
      measures: {},
    };
    Object.entries(cell.dimensions).forEach(([name, value]) => {
      record[name] = value;
    });
    if (cell.role === 'value' && cell.subjectCount === 0) {
      record.state = 'no_records';
      summary.noRecordCells += 1;
      for (const measure of spec.measures) {
        record.measures[measure.name] = null;
      }
    } else if (isSuppressed) {
      record.state = 'suppressed';
      record.reasons = reasons.get(cell.cellId) ?? [{rule: 'complementary', threshold}];
      summary.suppressedCells += 1;
      for (const measure of spec.measures) {
        record.measures[measure.name] = null;
      }
    } else {
      const numericMeasures = spec.measures.filter(measure => measure.operation !== 'count');
      let allZero = cell.role === 'value' && numericMeasures.length > 0;
      for (const measure of spec.measures) {
        const value = measure.operation === 'count' ? cell.subjectCount : combine(
          cell.reps.map(row => row[measure.source]), measure.operation);
        record.measures[measure.name] = value;
        if (measure.operation !== 'count' && value !== null && value !== 0) {
          allZero = false;
        }
      }
      record.state = allZero ? 'zero' : 'published';
      if (record.state === 'zero') {
        summary.zeroCells += 1;
      } else {
        summary.publishedCells += 1;
      }
    }
    records.push(record);
  }
  const report = {
    mode: 'aggregate',
    inputRows: rows.length,
    selectedRows: selected.length,
    emptySubjectRows,
    distinctSubjects,
    threshold,
    maximumCells: spec.maximumCells,
    cells: cells.length,
    ...summary,
    suppression: {
      primaryCells,
      complementaryCells: suppressed.size - primaryCells,
      complementaryCycles: cycle,
      reasons: [...reasons.entries()].map(([cellId, entries]) => ({cellId, entries})),
    },
    columns: outputColumns(spec),
  };
  return {records, report, fingerprint: checksum(records), filters, spec};
}

function outputColumns(spec) {
  return [...spec.groupBy, 'level', 'cell', 'state', ...spec.measures.map(measure => measure.name)];
}

function makeCell(spec, values, mask, role, source) {
  const dimensions = {};
  const coordinates = spec.groupBy.map((name, position) => mask[position] ? values[position] : null);
  spec.groupBy.forEach((name, position) => {
    if (mask[position]) {
      dimensions[name] = values[position];
    }
  });
  return {
    role,
    level: mask.filter(Boolean).length,
    dimensions,
    coordinates,
    subjects: new Set(source.subjects),
    reps: [...source.reps],
    subjectCount: source.subjects.size,
  };
}

function isAncestor(ancestor, cell) {
  if (ancestor.cellId === cell.cellId || ancestor.level > cell.level) {
    return false;
  }
  return ancestor.coordinates.every((value, position) => value === null || cell.coordinates[position] === value);
}

export function aggregateTable(records, spec) {
  const columns = outputColumns(spec);
  return records.map(record => {
    const row = {};
    for (const name of spec.groupBy) {
      row[name] = Object.hasOwn(record, name) ? record[name] : null;
    }
    row.level = record.level;
    row.cell = record.cell;
    row.state = record.state;
    for (const measure of spec.measures) {
      row[measure.name] = record.measures[measure.name];
    }
    demand(columns.every(column => Object.hasOwn(row, column)), 'aggregate_columns', 'Aggregate row is missing a locked column');
    return row;
  });
}
