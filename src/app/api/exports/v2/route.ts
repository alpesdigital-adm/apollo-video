import { NextResponse } from 'next/server';
import { createExportMatrix, preflightExports, renderExportCell, type OutputFormat } from '@/v2/domain/color-and-export';

export async function POST(request: Request) {
  const body = await request.json();
  if (body.operation === 'create') {
    const cells = createExportMatrix(body.recipeIds, body.formats as OutputFormat[], body.locales);
    return NextResponse.json({ cells, preflight: preflightExports(cells, body.constraints) });
  }
  if (body.operation === 'render-cell') return NextResponse.json({ cells: renderExportCell(body.cells, body.id, body.success) });
  return NextResponse.json({ error: 'unsupported-operation' }, { status: 400 });
}
