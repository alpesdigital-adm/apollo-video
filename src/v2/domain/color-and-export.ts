export const OUTPUT_FORMATS = ['9:16', '16:9', '4:5', '1:1', '21:9'] as const;
export type OutputFormat = typeof OUTPUT_FORMATS[number];

export type ColorTransform = { id: string; kind: 'technical' | 'match' | 'creative-lut' | 'output'; version: string; enabled: boolean };
export type ColorMetadata = { colorSpace: string; transfer: string; primaries: string };
export type ColorPlan = {
  metadata: ColorMetadata;
  global: ColorTransform[];
  sources?: Record<string, ColorTransform[]>;
  cameras?: Record<string, ColorTransform[]>;
  segments?: Record<string, ColorTransform[]>;
};

const ORDER: ColorTransform['kind'][] = ['technical', 'match', 'creative-lut', 'output'];

export function resolveColorPlan(plan: ColorPlan, ref: { sourceId?: string; cameraId?: string; segmentId?: string }) {
  const layers = [plan.global, ref.sourceId ? plan.sources?.[ref.sourceId] : undefined, ref.cameraId ? plan.cameras?.[ref.cameraId] : undefined, ref.segmentId ? plan.segments?.[ref.segmentId] : undefined];
  const selected = new Map<ColorTransform['kind'], ColorTransform>();
  for (const layer of layers) for (const transform of layer ?? []) if (transform.enabled) selected.set(transform.kind, transform);
  const transforms = ORDER.flatMap(kind => selected.has(kind) ? [selected.get(kind)!] : []);
  if (new Set(transforms.map(item => item.kind)).size !== transforms.length) throw new Error('duplicate-color-transform');
  return { metadata: plan.metadata, transforms, manifestKey: transforms.map(item => `${item.id}@${item.version}`).join('>') || 'color:none' };
}

export type LutRecord = { id: string; name: string; owner: string; license: string; tags: string[]; version: number; active: boolean; cube: string };
export function parseCube(input: { id: string; name: string; owner: string; license: string; tags?: string[]; cube: string }): LutRecord {
  const size = Number(input.cube.match(/LUT_3D_SIZE\s+(\d+)/)?.[1]);
  const rows = input.cube.split(/\r?\n/).filter(line => /^\s*-?\d/.test(line));
  if (!Number.isInteger(size) || size < 2 || rows.length !== size ** 3 || rows.some(row => row.trim().split(/\s+/).length !== 3)) throw new Error('invalid-cube');
  return { ...input, name: input.name.normalize('NFC'), tags: input.tags ?? [], version: 1, active: true };
}

export function selectWorkspaceLut(input: { projectChoice?: string | 'none'; workspaceDefault?: string; library: LutRecord[] }) {
  if (input.projectChoice === 'none') return undefined;
  const id = input.projectChoice ?? input.workspaceDefault;
  return input.library.find(item => item.id === id && item.active);
}

export type ExportCell = { id: string; recipeId: string; format: OutputFormat; locale: string; status: 'queued' | 'rendering' | 'ready' | 'failed'; artifact?: string; attempts: number };
export function createExportMatrix(recipeIds: string[], formats: OutputFormat[], locales: string[]) {
  const cells: ExportCell[] = [];
  for (const recipeId of recipeIds) for (const format of formats) for (const locale of locales) cells.push({ id: `${recipeId}__${format.replace(':', 'x')}__${locale}`, recipeId, format, locale, status: 'queued', attempts: 0 });
  return cells;
}

export function preflightExports(cells: ExportCell[], input: { rights: boolean; ready: boolean; budget: number; storageMb: number; costPerCell?: number; mbPerCell?: number }) {
  const cost = cells.length * (input.costPerCell ?? 1);
  const storageMb = cells.length * (input.mbPerCell ?? 50);
  const blockers = [...(!input.rights ? ['rights'] : []), ...(!input.ready ? ['readiness'] : []), ...(cost > input.budget ? ['budget'] : []), ...(storageMb > input.storageMb ? ['storage'] : [])];
  return { allowed: blockers.length === 0, blockers, quantity: cells.length, cost, storageMb };
}

export function renderExportCell(cells: ExportCell[], id: string, success: boolean) {
  return cells.map(cell => cell.id !== id ? cell : { ...cell, status: success ? 'ready' as const : 'failed' as const, attempts: cell.attempts + 1, artifact: success ? `${cell.id}.mp4` : undefined });
}

export const SDR_COLOR_FIXTURES = [
  { source: 'rec709-camera-a', expected: 'no-clipping' },
  { source: 'log-camera-b', expected: 'technical-before-creative' },
  { source: 'phone-hlg', expected: 'output-sdr-within-range' },
];
