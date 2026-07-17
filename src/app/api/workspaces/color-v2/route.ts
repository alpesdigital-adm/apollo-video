import { NextResponse } from 'next/server';
import { parseCube, resolveColorPlan, selectWorkspaceLut } from '@/v2/domain/color-and-export';

export async function POST(request: Request) {
  const body = await request.json();
  try {
    if (body.operation === 'parse-lut') return NextResponse.json({ lut: parseCube(body.lut) });
    if (body.operation === 'select-lut') return NextResponse.json({ lut: selectWorkspaceLut(body) ?? null });
    if (body.operation === 'compile-plan') return NextResponse.json(resolveColorPlan(body.plan, body.ref));
    return NextResponse.json({ error: 'unsupported-operation' }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'invalid-color-request' }, { status: 422 });
  }
}
