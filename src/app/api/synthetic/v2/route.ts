import { NextResponse } from 'next/server';
import { catalogSyntheticMaster, compileSyntheticEditPlan, evaluateSyntheticBlock, prepareAudio, reuseSyntheticBlock, splitSyntheticBlocks, validateHybridStory } from '@/v2/domain/synthetic-production';

export async function POST(request: Request) {
  const body = await request.json();
  try {
    if (body.operation === 'prepare-audio') return NextResponse.json(prepareAudio(body.input));
    if (body.operation === 'plan') { const audio = prepareAudio(body.input); const blocks = splitSyntheticBlocks(body.input.text, { audio, profile: body.profile, providerCapability: body.capability, settings: body.settings }); return NextResponse.json({ audio, blocks, editPlan: compileSyntheticEditPlan({ ...body.input, profile: body.profile, audio, blocks }) }); }
    if (body.operation === 'validate-hybrid') return NextResponse.json(validateHybridStory(body.blocks));
    if (body.operation === 'catalog-master') return NextResponse.json({ segments: catalogSyntheticMaster(body.asset) });
    if (body.operation === 'reuse') return NextResponse.json(reuseSyntheticBlock(body.asset, body.cacheKey) ?? null);
    if (body.operation === 'evaluate') return NextResponse.json(evaluateSyntheticBlock(body.input));
    return NextResponse.json({ error: 'unsupported-operation' }, { status: 400 });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'invalid-synthetic-request' }, { status: 422 }); }
}
