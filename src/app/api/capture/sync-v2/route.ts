import { NextResponse } from 'next/server';
import { addCaptureTrack, alignSeparateAudio, chooseSyncStrategy, coverageDiagnostic, detectClockPieces, fitDrift, synthesizeEditorialStory } from '@/v2/domain/capture-synchronization';

export async function POST(request: Request) {
  const body = await request.json();
  try {
    if (body.operation === 'synthesize-story') return NextResponse.json(synthesizeEditorialStory(body.ranges, body.objective));
    if (body.operation === 'add-track') return NextResponse.json(addCaptureTrack(body.session, body.track));
    if (body.operation === 'choose-sync') return NextResponse.json(chooseSyncStrategy(body.signals));
    if (body.operation === 'coverage') return NextResponse.json(coverageDiagnostic(body.track, body.range));
    if (body.operation === 'fit-drift') return NextResponse.json(fitDrift(body.anchors));
    if (body.operation === 'pieces') return NextResponse.json({ pieces: detectClockPieces(body.points) });
    if (body.operation === 'align-audio') return NextResponse.json({ tracks: alignSeparateAudio(body.session, body.masterId, body.signalsByTrack) });
    return NextResponse.json({ error: 'unsupported-operation' }, { status: 400 });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'invalid-sync-request' }, { status: 422 }); }
}
