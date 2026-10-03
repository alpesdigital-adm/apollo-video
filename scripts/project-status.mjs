import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataPath = path.join(root, 'docs/quality/project-status.json');
const dashboardPath = path.join(root, 'docs/PROJECT-STATUS.md');
const todoPath = path.join(root, 'TODO.md');
export const states = ['validado', 'pendente-validacao', 'em-construcao', 'fila'];
const enums = {
  kind: ['wave', 'capability'],
  construction: ['not-started', 'implemented', 'in-progress', 'unknown'],
  integration: ['main', 'not-integrated', 'unknown'],
  validation: ['none', 'isolated', 'controlled-e2e', 'real-e2e', 'accepted', 'documented', 'unknown'],
  deployment: ['pending', 'historical', 'current', 'not-applicable'],
  acceptance: ['pending', 'accepted', 'not-applicable'],
};
const blockerKinds = ['implementation', 'validation', 'live-provider', 'deployment', 'owner-acceptance', 'classification'];
const evidenceTypes = ['repo', 'ci', 'pr', 'private'];
const evidenceRoles = ['classification', 'implementation', 'integration', 'planned-not-started', 'controlled-e2e', 'real-e2e', 'deployment', 'owner-acceptance', 'historical-acceptance', 'document-result'];
const verifiedValidation = ['controlled-e2e', 'real-e2e', 'accepted', 'documented'];
const shaPattern = /^[a-f0-9]{40}$/i;

function nonempty(value) { return typeof value === 'string' && value.trim().length > 0; }
function assert(condition, message) { if (!condition) throw new Error(message); }
function exactKeys(value, names, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label}: expected object`);
  const actual = Object.keys(value).sort();
  assert(actual.join('\0') === [...names].sort().join('\0'), `${label}: unexpected or missing fields`);
}
function validEnum(value, choices, label) { assert(choices.includes(value), `${label}: invalid value`); }
function uniqueStrings(values, label) {
  assert(Array.isArray(values) && values.every(nonempty), `${label}: expected nonempty strings`);
  assert(new Set(values).size === values.length, `${label}: duplicates`);
}

function digest(value) { return createHash('sha256').update(value).digest('hex').slice(0, 12); }
export function parseTodo(text) {
  const sections = [];
  const items = [];
  const bySection = new Map();
  const occurrence = new Map();
  const headingStack = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      headingStack.length = level - 1;
      headingStack[level - 1] = heading[2].trim();
      continue;
    }
    const box = line.match(/^\s*- \[([x ])\]\s+(.+)$/);
    if (!box) continue;
    const text = box[2].trim().replace(/\s+/g, ' ');
    const base = digest(text);
    const nth = (occurrence.get(base) ?? 0) + 1;
    occurrence.set(base, nth);
    const id = `${base}-${nth}`;
    const headingPath = headingStack.filter(Boolean);
    const nearest = headingPath.at(-1) ?? '(sem seção)';
    const matchedId = nearest.match(/\bF\d+\.\d+\b/);
    const key = matchedId ? matchedId[0] : `H-${digest(headingPath.join(' > '))}`;
    let section = bySection.get(key);
    if (!section) {
      section = { key, heading: nearest, path: headingPath, items: [] };
      bySection.set(key, section);
      sections.push(section);
    } else {
      assert(section.path.join('\0') === headingPath.join('\0'), `TODO heading key collision: ${key}`);
    }
    section.items.push(id);
    items.push({ id, sectionKey: key, checked: box[1] === 'x', text, line: index + 1 });
  }
  return { sections, items };
}

export function ownerOnly(item) {
  return item.construction === 'implemented'
    && item.integration === 'main'
    && item.state === 'validado'
    && item.deployment === 'current'
    && item.acceptance === 'pending'
    && item.blockers.length > 0
    && item.blockers.every((blocker) => blocker.kind === 'owner-acceptance')
    && item.evidence.some((evidence) => evidence.role === 'deployment');
}
function needsClassification(item) {
  return item.kind === 'capability' && item.blockers.some((blocker) => blocker.kind === 'classification');
}

export function validateStatus(data, todoText, evidenceRoot = root) {
  const topKeys = ['schemaVersion', 'updatedAt', 'audit', 'evidenceBaseCommit', 'items'];
  if (data?.coverage !== undefined) topKeys.push('coverage');
  exactKeys(data, topKeys, 'status');
  assert(data.schemaVersion === 1, 'schemaVersion must be 1');
  assert(nonempty(data.updatedAt) && !Number.isNaN(Date.parse(data.updatedAt)), 'updatedAt must be a date');
  assert(shaPattern.test(data.evidenceBaseCommit), 'evidenceBaseCommit must be a full SHA');
  exactKeys(data.audit, ['delivered', 'total', 'source'], 'audit');
  assert(data.audit.source === 'TODO.md', 'audit.source must be TODO.md');
  assert(Number.isSafeInteger(data.audit.delivered) && data.audit.delivered >= 0, 'audit.delivered invalid');
  assert(Number.isSafeInteger(data.audit.total) && data.audit.total >= data.audit.delivered, 'audit.total invalid');
  if (todoText !== undefined) {
    const parsedTodo = parseTodo(todoText);
    const done = parsedTodo.items.filter((item) => item.checked).length;
    const open = parsedTodo.items.length - done;
    assert(done === data.audit.delivered && done + open === data.audit.total,
      `TODO audit drift: JSON ${data.audit.delivered}/${data.audit.total}, TODO ${done}/${done + open}`);
    const header = todoText.match(/\*\*([\d.]+) de ([\d.]+) microtarefas verificadas/);
    assert(header && Number(header[1].replaceAll('.', '')) === done
      && Number(header[2].replaceAll('.', '')) === done + open, 'TODO audit header drift');
    for (const match of todoText.matchAll(/^\|\s*Microtarefas\/checks abertos\s*\|\s*([\d.]+)\s*\|/gm)) {
      assert(Number(match[1].replaceAll('.', '')) === open, 'TODO open-checks table drift');
    }
    for (const match of todoText.matchAll(/\*\*([\d.]+) microtarefas abertas\b/g)) {
      assert(Number(match[1].replaceAll('.', '')) === open, 'TODO open-task statement drift');
    }
  }
  if (data.coverage !== undefined) {
    exactKeys(data.coverage, ['unit', 'total', 'classified', 'unclassified'], 'coverage');
    assert(data.coverage.unit === 'todo-section', 'coverage unit must be todo-section');
    for (const key of ['total', 'classified', 'unclassified']) {
      assert(Number.isSafeInteger(data.coverage[key]) && data.coverage[key] >= 0, `coverage.${key} invalid`);
    }
    assert(data.coverage.classified + data.coverage.unclassified === data.coverage.total, 'coverage counts disagree');
  }
  assert(Array.isArray(data.items), 'items must be an array');
  const ids = new Set();
  const mappedTasks = new Map();
  const unclassifiedSections = new Set();
  for (const [index, item] of data.items.entries()) {
    const label = `items[${index}]`;
    const itemKeys = ['id', 'title', 'kind', 'todoSections', 'state', 'construction', 'integration', 'validation', 'deployment', 'acceptance', 'blockers', 'evidence', 'nextAction'];
    if (item?.notes !== undefined) itemKeys.push('notes');
    if (item?.todoItems !== undefined) itemKeys.push('todoItems');
    if (item?.resultKind !== undefined) itemKeys.push('resultKind');
    exactKeys(item, itemKeys, label);
    assert(nonempty(item.id) && !ids.has(item.id), `${label}: missing/duplicate id`); ids.add(item.id);
    assert(nonempty(item.title) && nonempty(item.nextAction), `${label}: title/nextAction required`);
    if (item.notes !== undefined) assert(nonempty(item.notes), `${label}.notes must be nonempty`);
    if (item.resultKind !== undefined) validEnum(item.resultKind, ['product', 'document'], `${label}.resultKind`);
    validEnum(item.kind, enums.kind, `${label}.kind`);
    uniqueStrings(item.todoSections, `${label}.todoSections`);
    assert(item.todoSections.length > 0, `${label}.todoSections required`);
    if (item.todoItems !== undefined) uniqueStrings(item.todoItems, `${label}.todoItems`);
    validEnum(item.state, states, `${label}.state`);
    for (const key of Object.keys(enums).filter((key) => key !== 'kind')) validEnum(item[key], enums[key], `${label}.${key}`);
    assert(Array.isArray(item.blockers), `${label}.blockers must be an array`);
    for (const blocker of item.blockers) {
      exactKeys(blocker, ['kind', 'text'], `${label}.blocker`);
      validEnum(blocker.kind, blockerKinds, `${label}.blocker.kind`);
      assert(nonempty(blocker.text), `${label}.blocker.text required`);
    }
    if (data.coverage !== undefined && item.kind === 'capability') {
      assert(item.todoItems !== undefined && item.todoItems.length > 0, `${label}: capability must map TODO task IDs`);
      for (const taskId of item.todoItems) {
        assert(!mappedTasks.has(taskId), `${label}: duplicate TODO task ID ${taskId}`);
        mappedTasks.set(taskId, item);
      }
      if (item.blockers.some((blocker) => blocker.kind === 'classification')) {
        for (const section of item.todoSections) unclassifiedSections.add(section);
      }
    }
    assert(Array.isArray(item.evidence), `${label}.evidence must be an array`);
    for (const evidence of item.evidence) {
      exactKeys(evidence, ['type', 'ref', 'scope', 'role'], `${label}.evidence`);
      validEnum(evidence.type, evidenceTypes, `${label}.evidence.type`);
      validEnum(evidence.role, evidenceRoles, `${label}.evidence.role`);
      assert(nonempty(evidence.ref) && nonempty(evidence.scope), `${label}.evidence ref/scope required`);
      if (evidence.type === 'repo') {
        const relative = evidence.ref.split('#', 1)[0];
        const absolute = path.resolve(evidenceRoot, relative);
        assert(relative && !path.isAbsolute(relative) && absolute.startsWith(`${path.resolve(evidenceRoot)}${path.sep}`)
          && existsSync(absolute) && statSync(absolute).isFile(), `${label}.evidence repo ref must be an existing relative file`);
      }
      if (evidence.type === 'ci' || evidence.type === 'pr') {
        let url;
        try { url = new URL(evidence.ref); } catch { throw new Error(`${label}.evidence ${evidence.type} ref must be a GitHub URL`); }
        assert(url.protocol === 'https:' && url.hostname === 'github.com'
          && (evidence.type === 'ci' ? /^\/[^/]+\/[^/]+\/actions\/runs\/\d+\/?$/.test(url.pathname)
            : /^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(url.pathname)),
        `${label}.evidence ${evidence.type} ref must be a GitHub ${evidence.type} URL`);
      }
    }
    if (item.state === 'validado') {
      assert(item.construction === 'implemented' && item.integration === 'main', `${label}: validated item must be implemented on main`);
      assert(verifiedValidation.includes(item.validation) && item.evidence.length > 0, `${label}: validated item requires scoped validation evidence`);
      if (item.validation === 'documented') {
        assert(item.resultKind === 'document' && item.deployment === 'not-applicable' && item.acceptance === 'not-applicable',
          `${label}: documented validation requires document result with inapplicable deployment/acceptance`);
        assert(item.evidence.some((evidence) => evidence.role === 'document-result' && evidence.type === 'repo'),
          `${label}: documented result needs an existing repo document-result`);
      } else {
        assert(item.resultKind !== 'document', `${label}: product validation cannot claim a document result`);
      }
      const requiredRole = item.validation === 'accepted'
        ? (item.deployment === 'historical' ? 'historical-acceptance' : 'owner-acceptance')
        : item.validation === 'documented' ? 'document-result' : item.validation;
      assert(item.evidence.some((evidence) => evidence.role === requiredRole && evidence.type !== 'pr'),
        `${label}: validated item needs non-PR evidence matching validation`);
    }
    if (item.validation === 'documented') assert(item.state === 'validado', `${label}: documented validation must be scoped validated`);
    if (item.validation === 'accepted') {
      assert(item.acceptance === 'accepted', `${label}: accepted validation requires acceptance accepted`);
    }
    if (item.blockers.some((blocker) => blocker.kind === 'classification')) {
      assert(item.state === 'pendente-validacao' && item.validation === 'unknown',
        `${label}: classification blocker cannot hide a validated or constructed scope`);
    }
    if (item.state === 'fila') {
      assert(item.construction === 'not-started', `${label}: queued item cannot claim construction`);
      assert(item.evidence.some((evidence) => evidence.role === 'planned-not-started' && evidence.type === 'repo'),
        `${label}: queued scope needs explicit repo planned/not-started evidence`);
    }
    if (item.state === 'em-construcao') assert(item.construction === 'in-progress', `${label}: construction must be in progress`);
    if (item.acceptance === 'accepted') {
      assert(['current', 'historical'].includes(item.deployment), `${label}: accepted item needs current or historical deployment`);
      const required = item.deployment === 'historical' ? ['historical-acceptance'] : ['deployment', 'owner-acceptance'];
      for (const role of required) assert(item.evidence.some((evidence) => evidence.role === role && evidence.type !== 'pr'),
        `${label}: accepted item needs ${role} evidence`);
    }
  }
  if (data.coverage !== undefined && todoText !== undefined) {
    const parsed = parseTodo(todoText);
    const actual = new Set(parsed.items.map((item) => item.id));
    assert(mappedTasks.size === actual.size && [...mappedTasks.keys()].every((id) => actual.has(id)),
      `TODO task coverage drift: mapped ${mappedTasks.size}/${actual.size}`);
    const sections = new Set(parsed.sections.map((section) => section.key));
    for (const item of data.items) {
      for (const key of item.todoSections) assert(sections.has(key), `Unknown TODO section: ${key}`);
      if (item.kind === 'capability') {
        for (const id of item.todoItems) {
          const task = parsed.items.find((entry) => entry.id === id);
          assert(item.todoSections.includes(task.sectionKey), `TODO task ${id} assigned outside declared section`);
        }
      }
    }
    assert(data.coverage.total === sections.size, 'coverage.total differs from parsed TODO sections');
    assert(data.coverage.unclassified === unclassifiedSections.size
      && data.coverage.classified === sections.size - unclassifiedSections.size,
    'coverage classification counts differ from rows');
  }
  return data;
}

export function snapshot(data, state, classification = false) {
  const classified = data.items.filter((item) => !needsClassification(item));
  const triage = data.items.filter(needsClassification);
  const counts = Object.fromEntries(enums.kind.map((kind) => [kind,
    Object.fromEntries(states.map((name) => [name, classified.filter((item) => item.kind === kind && item.state === name).length]))]));
  const taskCounts = Object.fromEntries(states.map((name) => [name,
    classified.filter((item) => item.kind === 'capability' && item.state === name)
      .reduce((sum, item) => sum + (item.todoItems?.length ?? 0), 0)]));
  const classificationTaskCount = triage.reduce((sum, item) => sum + (item.todoItems?.length ?? 0), 0);
  return {
    schemaVersion: data.schemaVersion, updatedAt: data.updatedAt, audit: data.audit,
    evidenceBaseCommit: data.evidenceBaseCommit, ...(data.coverage ? { coverage: data.coverage } : {}),
    counts, taskCounts, classificationCount: triage.length, classificationTaskCount,
    ownerOnlyCount: classified.filter(ownerOnly).length,
    items: data.items.filter((item) => classification ? needsClassification(item) : !state || (!needsClassification(item) && item.state === state))
      .map((item) => ({ ...item, ownerOnly: ownerOnly(item) })),
  };
}

function escapeCell(value) { return String(value).replaceAll('|', '\\|').replaceAll('\n', ' '); }
function evidenceLinks(item) {
  return item.evidence.map((entry) => {
    if (entry.type === 'private') return `privado (${entry.role}; referência local no JSON)`;
    const target = entry.type === 'repo' ? `../${encodeURI(entry.ref)}` : entry.ref;
    const label = entry.type === 'repo' ? `${entry.role}: ${entry.ref}` : `${entry.role}: ${entry.type.toUpperCase()} ${entry.ref.split('/').at(-1)}`;
    return `[${label.replaceAll('[', '').replaceAll(']', '')}](${target})`;
  }).join(', ');
}
export function renderDashboard(data) {
  const view = snapshot(data);
  const dataHash = createHash('sha256').update(JSON.stringify(data)).digest('hex');
  const waveItems = view.items.filter((item) => item.kind === 'wave');
  const capabilityItems = view.items.filter((item) => item.kind === 'capability');
  const unclassifiedItems = capabilityItems.filter(needsClassification);
  const classifiedItems = capabilityItems.filter((item) => !needsClassification(item));
  const lines = [
    '# Apollo — status por escopo', '',
    `Atualizado: ${data.updatedAt}. Evidência-base: \`${data.evidenceBaseCommit}\`.`, '',
    `Snapshot SHA256: \`${dataHash}\`.`, '',
    `TODO auditado: **${data.audit.delivered}/${data.audit.total}** microtarefas entregues. Este número vem de \`TODO.md\`; os estados abaixo descrevem somente os escopos declarados, sem somar progresso.`, '',
    ...(data.coverage ? [`Organização do registro: **${data.coverage.classified}/${data.coverage.total}** seções completas; **${data.coverage.unclassified}** pendentes de classificação. Isto não altera as **${data.audit.delivered}/${data.audit.total}** caixas auditadas como entrega.`, ''] : []),
    `Só aceite do owner: **${view.ownerOnlyCount}** linhas. Triagem de classificação: **${view.classificationCount} linhas / ${view.classificationTaskCount} caixas**.`, '',
    `Validação pendente identificada: **${view.counts.capability['pendente-validacao']} linha(s) / ${view.taskCounts['pendente-validacao']} caixa(s)**. As ${view.classificationTaskCount} caixas em triagem não entram nessa contagem.`, '',
    ...(view.counts.capability.fila === 0
      ? ['Zero linhas em fila confirmada não significa backlog concluído; caixas abertas sem prova de início exigem classificação.', '']
      : [`Fila confirmada: **${view.counts.capability.fila} linha(s) / ${view.taskCounts.fila} caixa(s)**. A fila registra apenas escopo planejado com prova de que ainda não começou.`, '']),
    '“Caixas” conta as tarefas incluídas em cada escopo; não significa que toda subtarefa de um grupo parcial já começou.', '',
    'IDs de caixas preservam a identidade ao trocar `[ ]` por `[x]`; mudar ou duplicar o texto exige revisar o mapa de IDs. O papel declarado de uma evidência não dispensa revisão semântica do seu conteúdo.', '',
    '| Tipo | Estado | Itens |', '| --- | --- | ---: |',
    ...enums.kind.flatMap((kind) => states.map((state) => `| ${kind} | ${state} | ${view.counts[kind][state]} |`)), '',
    `Triagem de classificação: ${view.classificationCount} linhas capability.`, '',
    '| Estado da capability | Caixas TODO |', '| --- | ---: |',
    ...states.map((state) => `| ${state} | ${view.taskCounts[state]} |`), '',
    `Caixas em triagem de classificação: **${view.classificationTaskCount}**. A soma dos quatro estados e da triagem é **${Object.values(view.taskCounts).reduce((sum, value) => sum + value, 0) + view.classificationTaskCount}**.`, '',
    '## Waves', '',
    '| ID | Escopo | Estado | Integração | Validação | Implantação | Aceite | Só aceite do owner? | Evidências | Próxima ação |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...waveItems.map((item) => `| ${[item.id, item.title, item.state, item.integration, item.validation, item.deployment, item.acceptance, item.ownerOnly ? 'sim' : 'não', evidenceLinks(item), item.nextAction].map(escapeCell).join(' | ')} |`), '',
    ...states.flatMap((state) => [
      `## Capabilities — ${state}`, '',
      '| ID | Escopo | Caixas | Resultado | Validação | Implantação | Aceite | Bloqueio | Evidências | Próxima ação |', '| --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- |',
      ...classifiedItems.filter((item) => item.state === state).map((item) => `| ${[item.id, item.title, item.todoItems?.length ?? 0, item.resultKind ?? 'product', item.validation, item.deployment, item.acceptance, item.blockers.map((blocker) => blocker.kind).join(', ') || 'nenhum', evidenceLinks(item), item.nextAction].map(escapeCell).join(' | ')} |`), '',
    ]),
    '## Classificação pendente', '',
    `**${view.classificationTaskCount} caixas** em ${unclassifiedItems.length} linhas sem evidência suficiente para um dos quatro estados. Cada linha exige revisão semântica da evidência; o status do checkbox sozinho não prova validação nem início.`, '',
    ...(unclassifiedItems.length ? unclassifiedItems.map((item) => `- ${item.id}: ${item.title} (${item.todoItems?.length ?? 0} caixas) — ${item.nextAction}`) : ['Nenhuma linha com bloqueio de classificação.']), '',
    '“Validado” identifica o escopo da linha: `documented` prova um documento como resultado; `accepted` preserva um aceite histórico ou atual declarado; `controlled-e2e`/`real-e2e` indicam validação técnica. Nenhuma dessas etiquetas transforma automaticamente outro escopo em produto implantado e aceito.', '',
  ];
  return lines.join('\n');
}

export function assertDashboardCurrent(data, existing) {
  assert(existing.replaceAll('\r\n', '\n') === renderDashboard(data), 'Dashboard drift; run npm run project:status -- --write');
}

function parseArgs(argv) {
  const opts = { check: false, write: false, json: false, all: false, classification: false, state: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check' || arg === '--write' || arg === '--json' || arg === '--all' || arg === '--classification') opts[arg.slice(2)] = true;
    else if (arg === '--state' && i + 1 < argv.length) opts.state = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (opts.state) validEnum(opts.state, states, '--state');
  assert(!(opts.state && opts.classification) && !(opts.all && (opts.state || opts.classification)), '--state, --classification and --all are exclusive');
  assert(!(opts.check && opts.write), '--check and --write cannot be combined');
  assert(!(opts.write && (opts.state || opts.json || opts.all || opts.classification)), '--write generates the full dashboard only');
  return opts;
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const [raw, todoText] = await Promise.all([readFile(dataPath, 'utf8'), readFile(todoPath, 'utf8')]);
  const data = validateStatus(JSON.parse(raw), todoText);
  const dashboard = renderDashboard(data);
  if (opts.check) {
    const existing = await readFile(dashboardPath, 'utf8');
    assertDashboardCurrent(data, existing);
  }
  if (opts.write) await writeFile(dashboardPath, dashboard, 'utf8');
  if (opts.json) console.log(JSON.stringify(snapshot(data, opts.state, opts.classification), null, 2));
  else if (opts.write) console.log(`Updated ${path.relative(root, dashboardPath)}`);
  else if (opts.check) console.log('Project status consistent');
  else {
    const view = snapshot(data, opts.state, opts.classification);
    console.log(`TODO auditado: ${data.audit.delivered}/${data.audit.total}; linhas: ${enums.kind.map((kind) => `${kind}[${states.map((state) => `${state}=${view.counts[kind][state]}`).join(', ')}]`).join('; ')}`);
    console.log(`Caixas por estado capability: ${states.map((state) => `${state}=${view.taskCounts[state]}`).join(', ')}; triagem=${view.classificationTaskCount} caixas/${view.classificationCount} linhas; só aceite do owner=${view.ownerOnlyCount}`);
    if (data.coverage) console.log(`Organização do registro: ${data.coverage.classified}/${data.coverage.total} seções completas; ${data.coverage.unclassified} pendentes. Fila confirmada: ${view.counts.capability.fila} linha(s), ${view.taskCounts.fila} caixa(s).`);
    if (opts.state || opts.classification || opts.all) for (const item of view.items) console.log(`${item.id}\t${needsClassification(item) ? 'triagem' : item.state}\t${item.title}${item.ownerOnly ? '\towner acceptance only' : ''}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
