import { NextResponse } from 'next/server';
import { annotationToMask, calculateNovelty, chooseFallback, createProviderJob, createTransformationBrief, critiqueTransformation, planAdvancedCleanup, routeTransformation } from '@/v2/domain/generative-transformation';

export async function POST(request: Request) {
  const body = await request.json();
  try {
    if (body.operation === 'brief') return NextResponse.json(createTransformationBrief(body.input));
    if (body.operation === 'route') return NextResponse.json(routeTransformation(body.brief, body.providers, body.requirements));
    if (body.operation === 'submit') return NextResponse.json(createProviderJob(body.brief, body.transport));
    if (body.operation === 'novelty') return NextResponse.json(calculateNovelty(body.input));
    if (body.operation === 'fallback') return NextResponse.json(chooseFallback(body.brief, body.attempts));
    if (body.operation === 'critique') return NextResponse.json(critiqueTransformation(body.brief, body.result));
    if (body.operation === 'mask') return NextResponse.json(annotationToMask(body.input));
    if (body.operation === 'cleanup') return NextResponse.json(planAdvancedCleanup(body.input));
    return NextResponse.json({ error: 'unsupported-operation' }, { status: 400 });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'invalid-transformation-request' }, { status: 422 }); }
}
