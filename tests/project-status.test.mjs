import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, copyFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateStatus, snapshot, ownerOnly, renderDashboard, assertDashboardCurrent, parseTodo, buildTodoLedger } from '../scripts/project-status.mjs';

const todo = '# TODO\n**1 de 2 microtarefas verificadas como efetivamente entregues**\n## F1.001 — Escopo\n- [x] A\n- [ ] B\n';
function fixture() {
  return {
    schemaVersion: 1,
    updatedAt: '2026-10-03T00:00:00Z',
    audit: { delivered: 1, total: 2, source: 'TODO.md' },
    evidenceBaseCommit: '32150e9fca20f02a12887e19bc63c1b759bcd552',
    coverage: { unit: 'todo-section', total: 1, classified: 1, unclassified: 0 },
    items: [{
      id: 'F1', title: 'Escopo controlado', kind: 'capability', todoSections: ['F1.001'],
      todoItems: parseTodo(todo).items.map((item) => item.id), state: 'validado',
      construction: 'implemented', integration: 'main', validation: 'controlled-e2e',
      deployment: 'pending', acceptance: 'pending', blockers: [{ kind: 'deployment', text: 'Implantação pendente' }],
      evidence: [{ type: 'private', ref: 'controlled-proof', scope: 'Somente jornada controlada', role: 'controlled-e2e' }], nextAction: 'Validar implantação',
    }],
  };
}

test('validated means scoped technical evidence, not delivery or owner-only', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'apollo-status-'));
  try {
    await writeFile(path.join(dir, 'proof.md'), 'proof');
    const data = fixture();
    data.items[0].evidence = [{ type: 'repo', ref: 'proof.md', scope: 'Somente jornada controlada', role: 'controlled-e2e' }];
    validateStatus(data, todo, dir);
    assert.equal(snapshot(data).counts.wave.validado, 0);
    assert.equal(snapshot(data).counts.capability.validado, 1);
    assert.equal(snapshot(data).audit.delivered, 1);
    assert.equal(ownerOnly(data.items[0]), false);
    data.items[0].deployment = 'current';
    data.items[0].blockers = [{ kind: 'owner-acceptance', text: 'Aceite pendente' }];
    assert.equal(ownerOnly(data.items[0]), false);
    data.items[0].evidence.push({ type: 'private', ref: 'deployment-proof', scope: 'Implantação verificada', role: 'deployment' });
    assert.equal(ownerOnly(data.items[0]), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('rejects false validated claims and missing scoped evidence', () => {
  const data = fixture();
  data.items[0].validation = 'isolated';
  assert.throws(() => validateStatus(data, todo), /requires scoped validation evidence/);
  data.items[0].validation = 'real-e2e';
  data.items[0].evidence = [];
  assert.throws(() => validateStatus(data, todo), /requires scoped validation evidence/);
  data.items[0].evidence = [{ type: 'ci', ref: 'https://example.com/actions/runs/1', scope: 'Wrong host', role: 'controlled-e2e' }];
  assert.throws(() => validateStatus(data, todo), /GitHub ci URL/);
  data.items[0].evidence = [{ type: 'repo', ref: 'missing.md', scope: 'Missing source', role: 'controlled-e2e' }];
  assert.throws(() => validateStatus(data, todo), /existing relative file/);
});

test('rejects inflated or stale TODO counts, including its audit header', () => {
  const data = fixture();
  data.audit.delivered = 2;
  assert.throws(() => validateStatus(data, todo), /TODO audit drift/);
  data.audit.delivered = 1;
  assert.throws(() => validateStatus(data, todo.replace('1 de 2', '2 de 2')), /TODO audit header drift/);
  const historicalHeader = todo.replace('microtarefas verificadas como efetivamente entregues', 'caixas marcadas no registro histórico');
  assert.doesNotThrow(() => validateStatus(data, historicalHeader));
  assert.throws(() => validateStatus(data, historicalHeader.replace('1 de 2', '2 de 2')), /TODO audit header drift/);
  assert.throws(() => validateStatus(data, `${todo}| Microtarefas/checks abertos | 1204 |\n`), /open-checks table drift/);
  assert.throws(() => validateStatus(data, `${todo}**1204 microtarefas abertas**\n`), /open-task statement drift/);
});

test('a row edit invalidates the generated dashboard', () => {
  const data = fixture();
  const markdown = renderDashboard(data);
  assert.doesNotThrow(() => assertDashboardCurrent(data, markdown.replaceAll('\n', '\r\n')));
  data.items[0].state = 'pendente-validacao';
  assert.throws(() => assertDashboardCurrent(data, markdown), /Dashboard drift/);
});

test('queue and construction require explicit construction states', () => {
  const data = fixture();
  data.items[0].state = 'fila';
  assert.throws(() => validateStatus(data, todo), /queued item cannot claim construction/);
  data.items[0].state = 'em-construcao';
  assert.throws(() => validateStatus(data, todo), /construction must be in progress/);
});

test('historical acceptance is allowed without implying current deployment', () => {
  const data = fixture();
  data.items[0].acceptance = 'accepted';
  data.items[0].deployment = 'historical';
  data.items[0].validation = 'accepted';
  data.items[0].evidence.push({ type: 'private', ref: 'historical-proof', scope: 'Aceite anterior', role: 'historical-acceptance' });
  assert.doesNotThrow(() => validateStatus(data, todo));
  assert.equal(ownerOnly(data.items[0]), false);
});

test('a document may be validated only when the repo document is the declared result', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'apollo-status-document-'));
  try {
    await writeFile(path.join(dir, 'decision.md'), '# Decisão registrada\n');
    const data = fixture();
    const item = data.items[0];
    item.resultKind = 'document';
    item.validation = 'documented';
    item.deployment = 'not-applicable';
    item.acceptance = 'not-applicable';
    item.evidence = [{ type: 'repo', ref: 'decision.md', scope: 'A decisão documentada é o resultado desta caixa', role: 'document-result' }];
    assert.doesNotThrow(() => validateStatus(data, todo, dir));
    assert.equal(ownerOnly(item), false);
    delete item.resultKind;
    assert.throws(() => validateStatus(data, todo, dir), /documented validation requires document result/);
    item.resultKind = 'document';
    item.evidence[0].role = 'implementation';
    assert.throws(() => validateStatus(data, todo, dir), /existing repo document-result/);
    item.evidence[0].role = 'document-result';
    item.evidence[0].type = 'private';
    assert.throws(() => validateStatus(data, todo, dir), /existing repo document-result/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('TODO IDs survive checkbox changes and distinguish repeated text', () => {
  const before = parseTodo('# T\n## F0.001 A\n- [ ] Repetida\n- [ ] Repetida\n');
  const after = parseTodo('# T\n## F0.001 A\n- [x] Repetida\n- [ ] Repetida\n');
  assert.deepEqual(before.items.map((item) => item.id), after.items.map((item) => item.id));
  assert.notEqual(before.items[0].id, before.items[1].id);
  assert.equal(after.items[0].checked, true);
});

test('ledger inventories every ID once and keeps checked separate from current acceptance', () => {
  const data = fixture();
  const ledger = buildTodoLedger(data, todo);
  assert.equal(ledger.total, 2);
  assert.equal(ledger.checked, 1);
  assert.deepEqual(ledger.counts['falta-implantacao'], 2);
  assert.equal(ledger.checkedAwaitingDeploymentOrAcceptance, 1);
  assert.equal(ledger.checkedProductWithoutCurrentAcceptance, 1);
  assert.equal(ledger.pendingStageCount, 2);
  assert.equal(ledger.historicalTodoOnly, 0);
  assert.deepEqual(ledger.items.map(({ text, line, checked }) => ({ text, line, checked })), [
    { text: 'A', line: 4, checked: true }, { text: 'B', line: 5, checked: false },
  ]);
  assert.equal(Object.values(ledger.counts).reduce((sum, count) => sum + count, 0), 2);
  assert.equal(snapshot(data, undefined, false, todo).todoLedger.total, 2);
  const dashboard = renderDashboard(data, todo);
  assert.match(dashboard, /## Inventário completo do TODO/);
  assert.match(dashboard, /\| \*\*Total\*\* \| \*\*2\*\* \| \*\*1\*\* \|/);
  assert.doesNotThrow(() => assertDashboardCurrent(data, dashboard, todo));
});

test('partial construction remains individually unproved even with checked boxes or controlled evidence', () => {
  const data = fixture();
  const item = data.items[0];
  item.state = 'em-construcao';
  item.construction = 'in-progress';
  item.validation = 'controlled-e2e';
  item.blockers = [{ kind: 'implementation', text: 'Escopo parcial' }, { kind: 'validation', text: 'Falta validação individual' }];
  const ledger = buildTodoLedger(data, todo);
  assert.equal(ledger.counts['situacao-individual-nao-comprovada'], 2);
  assert.equal(ledger.checkedCounts['situacao-individual-nao-comprovada'], 1);
  assert.equal(ledger.counts['falta-validacao'], 0);
});

test('wave task links are contextual, deduplicated, and cannot promote a capability', () => {
  const data = fixture();
  const wave = structuredClone(data.items[0]);
  wave.id = 'W1';
  wave.kind = 'wave';
  wave.title = 'Wave associada';
  wave.deployment = 'current';
  wave.acceptance = 'accepted';
  wave.evidence.push({ type: 'private', ref: 'deployed', scope: 'Wave', role: 'deployment' });
  wave.evidence.push({ type: 'private', ref: 'accepted', scope: 'Wave', role: 'owner-acceptance' });
  data.items.push(wave);
  validateStatus(data, todo);
  const ledger = buildTodoLedger(data, todo);
  assert.equal(ledger.counts['implantado-e-aceito'], 0);
  assert.equal(ledger.counts['falta-implantacao'], 2);
  assert.deepEqual(ledger.items.map((item) => item.waves), [['W1'], ['W1']]);
  assert.equal(ledger.waveSummary[0].linkedTodoCount, 2);
  assert.equal(ledger.explicitWaveTodoIdCount, 2);
  assert.equal(ledger.sectionOnlyWaveCount, 0);
  wave.todoItems = ['invented-1'];
  assert.throws(() => validateStatus(data, todo), /references unknown TODO task/);
  delete wave.todoItems;
  assert.throws(() => validateStatus(data, todo), /wave requires explicit TODO task IDs/);
  wave.id = 'W24';
  assert.doesNotThrow(() => validateStatus(data, todo));
  wave.id = 'W1';
  wave.todoItems = [parseTodo(todo).items[0].id];
  wave.todoSections = ['H-invented'];
  assert.throws(() => validateStatus(data, todo), /Unknown TODO section/);
  const splitTodo = todo.replace('- [ ] B', '## F1.002 — Outro escopo\n- [ ] B');
  data.coverage.total = 2;
  data.coverage.classified = 2;
  data.items[0].todoSections.push('F1.002');
  wave.todoSections = ['F1.002'];
  assert.throws(() => validateStatus(data, splitTodo), /assigned outside declared section/);
});

test('document, historical acceptance, owner-only and technical blockers are distinct ledger buckets', () => {
  const data = fixture();
  const item = data.items[0];
  item.validation = 'accepted';
  item.deployment = 'historical';
  item.acceptance = 'accepted';
  item.evidence.push({ type: 'private', ref: 'historical', scope: 'Historical only', role: 'historical-acceptance' });
  assert.equal(buildTodoLedger(data, todo).counts['aceito-historico'], 2);
  item.validation = 'controlled-e2e';
  item.deployment = 'current';
  item.acceptance = 'pending';
  item.blockers = [{ kind: 'owner-acceptance', text: 'Pendente' }];
  item.evidence.push({ type: 'private', ref: 'deployment', scope: 'Current deployment', role: 'deployment' });
  assert.equal(buildTodoLedger(data, todo).counts['falta-aceite'], 2);
  item.deployment = 'pending';
  item.blockers.push({ kind: 'live-provider', text: 'Provider pendente' });
  assert.equal(buildTodoLedger(data, todo).counts['tecnico-com-bloqueios'], 2);
});

test('coverage rejects missing, duplicated and invented TODO task IDs', () => {
  const missing = fixture();
  missing.items[0].todoItems.pop();
  assert.throws(() => validateStatus(missing, todo), /TODO task coverage drift/);
  const duplicate = fixture();
  duplicate.items.push({ ...structuredClone(duplicate.items[0]), id: 'F1-copy' });
  assert.throws(() => validateStatus(duplicate, todo), /duplicate TODO task ID/);
  const invented = fixture();
  invented.items[0].todoItems[0] = '000000000000-1';
  assert.throws(() => validateStatus(invented, todo), /TODO task coverage drift/);
});

test('coverage section counts and classification blocker cannot be fabricated', () => {
  const data = fixture();
  data.coverage.total = 2;
  data.coverage.unclassified = 1;
  assert.throws(() => validateStatus(data, todo), /coverage.total differs/);
  data.coverage.total = 1;
  data.coverage.classified = 0;
  assert.throws(() => validateStatus(data, todo), /classification counts differ/);
});

test('classification is separate from pending counts and state filters', () => {
  const data = fixture();
  data.items[0].state = 'pendente-validacao';
  data.items[0].construction = 'unknown';
  data.items[0].validation = 'unknown';
  data.items[0].blockers = [{ kind: 'classification', text: 'Prova insuficiente' }];
  data.items[0].evidence = [{ type: 'private', ref: 'audit', scope: 'Classificação pendente', role: 'classification' }];
  data.coverage.classified = 0;
  data.coverage.unclassified = 1;
  assert.doesNotThrow(() => validateStatus(data, todo));
  assert.equal(snapshot(data).counts.capability['pendente-validacao'], 0);
  assert.equal(snapshot(data).taskCounts['pendente-validacao'], 0);
  assert.equal(snapshot(data).classificationCount, 1);
  assert.equal(snapshot(data).classificationTaskCount, 2);
  assert.equal(snapshot(data, 'pendente-validacao').items.length, 0);
  assert.equal(snapshot(data, undefined, true).items.length, 1);
  assert.equal(ownerOnly(data.items[0]), false);
  data.items[0].state = 'validado';
  data.items[0].construction = 'implemented';
  data.items[0].validation = 'controlled-e2e';
  data.items[0].evidence.push({ type: 'private', ref: 'run', scope: 'Jornada', role: 'controlled-e2e' });
  assert.throws(() => validateStatus(data, todo), /classification blocker cannot hide/);
});

test('declared proof roles cannot turn a generic link into acceptance or queue evidence', () => {
  const historical = fixture();
  historical.items[0].validation = 'accepted';
  historical.items[0].deployment = 'historical';
  historical.items[0].acceptance = 'accepted';
  historical.items[0].evidence = [{ type: 'repo', ref: 'TODO.md', scope: 'Checkbox only', role: 'classification' }];
  assert.throws(() => validateStatus(historical, todo), /non-PR evidence matching validation/);
  const queued = fixture();
  queued.items[0].state = 'fila';
  queued.items[0].construction = 'not-started';
  queued.items[0].validation = 'unknown';
  queued.items[0].evidence = [{ type: 'ci', ref: 'https://github.com/org/repo/actions/runs/1', scope: 'Generic CI', role: 'controlled-e2e' }];
  assert.throws(() => validateStatus(queued, todo), /planned\/not-started evidence/);
  const contradictory = fixture();
  contradictory.items[0].validation = 'accepted';
  contradictory.items[0].deployment = 'historical';
  contradictory.items[0].evidence[0].role = 'historical-acceptance';
  assert.throws(() => validateStatus(contradictory, todo), /accepted validation requires acceptance accepted/);
});

test('CLI writes and checks an isolated dashboard, filters JSON, and fails closed on drift', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'apollo-status-cli-'));
  try {
    await mkdir(path.join(dir, 'scripts'));
    await mkdir(path.join(dir, 'docs/quality'), { recursive: true });
    const source = fileURLToPath(new URL('../scripts/project-status.mjs', import.meta.url));
    await copyFile(source, path.join(dir, 'scripts/project-status.mjs'));
    await writeFile(path.join(dir, 'TODO.md'), todo);
    await writeFile(path.join(dir, 'docs/quality/project-status.json'), JSON.stringify(fixture()));
    const run = (...args) => spawnSync(process.execPath, ['scripts/project-status.mjs', ...args],
      { cwd: dir, encoding: 'utf8', timeout: 10_000 });
    assert.equal(run('--write').status, 0);
    assert.equal(run('--check').status, 0);
    const result = run('--json', '--state', 'validado');
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).items.length, 1);
    const taskResult = run('--json', '--task-state', 'falta-implantacao');
    assert.equal(taskResult.status, 0);
    assert.equal(JSON.parse(taskResult.stdout).todoLedger.items.length, 2);
    assert.equal(JSON.parse(taskResult.stdout).todoLedger.total, 2);
    assert.deepEqual(JSON.parse(taskResult.stdout).todoLedger.filter,
      { bucket: 'falta-implantacao', returnedItems: 2, countsScope: 'all-todo-items' });
    assert.match(run('--task-state', 'falta-implantacao').stdout, /TODO:4\tfalta-implantacao\tA/);
    assert.equal(run('--task-state', 'inventado').status, 1);
    assert.equal(run('--state', 'validado', '--task-state', 'falta-implantacao').status, 1);
    assert.equal(run('--json', '--state', 'made-up').status, 1);
    const dashboard = await readFile(path.join(dir, 'docs/PROJECT-STATUS.md'), 'utf8');
    await writeFile(path.join(dir, 'TODO.md'), todo.replace('1 de 2', '2 de 2'));
    assert.equal(run('--check').status, 1);
    assert.equal(await readFile(path.join(dir, 'docs/PROJECT-STATUS.md'), 'utf8'), dashboard);
    await writeFile(path.join(dir, 'TODO.md'), todo);
    const changed = fixture();
    changed.items[0].nextAction = 'Outra ação';
    await writeFile(path.join(dir, 'docs/quality/project-status.json'), JSON.stringify(changed));
    assert.equal(run('--check').status, 1);
    assert.equal(await readFile(path.join(dir, 'docs/PROJECT-STATUS.md'), 'utf8'), dashboard);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
