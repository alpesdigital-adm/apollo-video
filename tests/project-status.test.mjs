import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, copyFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateStatus, snapshot, ownerOnly, renderDashboard, assertDashboardCurrent, parseTodo } from '../scripts/project-status.mjs';

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
