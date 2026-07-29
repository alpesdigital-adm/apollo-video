import React from 'react';
import {
  AbsoluteFill,
  Img,
  OffthreadVideo,
  interpolate,
  useCurrentFrame,
} from 'remotion';
import { ColorPalette } from '../lib/types';

type ProofMode = 'cutaway' | 'split-screen' | 'proof-card';
type ProofMediaType = 'video' | 'image' | 'audio' | 'document';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Transition {
  kind: 'cut' | 'crossfade';
  durationFrames: number;
}

interface ProofPresentationProps {
  schemaVersion: 'proof-presentation/v1';
  proofModePlanId: string;
  proofModePlanHash: string;
  proofNeedItemId: string;
  mode: ProofMode;
  sourceMediaType: ProofMediaType;
  evidenceSrc: string;
  sourceStartFrame: number;
  claimText: string;
  attribution: string;
  qualifiers: string[];
  verbalAttribution: string;
  verbalQualifiers: string[];
  contextRequired: boolean;
  canvas: { width: number; height: number };
  evidenceRegion: Rect;
  presenterRegion?: Rect;
  creditRegion: Rect;
  qualifierRegion: Rect;
  minimumFontPixels: number;
  entryTransition: Transition;
  exitTransition: Transition;
  videoSrc?: string;
  durationInFrames?: number;
  palette: ColorPalette;
}

function regionStyle(rect: Rect): React.CSSProperties {
  return {
    position: 'absolute',
    left: rect.x,
    top: rect.y,
    width: rect.width,
    height: rect.height,
  };
}

const ProofMedia: React.FC<{
  sourceMediaType: ProofMediaType;
  evidenceSrc: string;
  sourceStartFrame: number;
  contextRequired: boolean;
}> = ({
  sourceMediaType,
  evidenceSrc,
  sourceStartFrame,
  contextRequired,
}) => {
  const style: React.CSSProperties = {
    width: '100%',
    height: '100%',
    objectFit: contextRequired ? 'contain' : 'cover',
    objectPosition: 'center center',
  };
  if (sourceMediaType === 'video') {
    return (
      <OffthreadVideo
        src={evidenceSrc}
        muted
        startFrom={sourceStartFrame}
        style={style}
      />
    );
  }
  if (sourceMediaType === 'image') {
    return <Img src={evidenceSrc} alt="" style={style} />;
  }
  return null;
};

const Presenter: React.FC<{
  videoSrc?: string;
}> = ({ videoSrc }) => (
  videoSrc ? (
    <OffthreadVideo
      src={videoSrc}
      muted
      style={{
        width: '100%',
        height: '100%',
        objectFit: 'cover',
        objectPosition: 'center 28%',
      }}
    />
  ) : null
);

export const ProofPresentation: React.FC<ProofPresentationProps> = ({
  schemaVersion,
  mode,
  sourceMediaType,
  evidenceSrc,
  sourceStartFrame,
  claimText,
  attribution,
  qualifiers,
  verbalAttribution,
  verbalQualifiers,
  contextRequired,
  evidenceRegion,
  presenterRegion,
  creditRegion,
  qualifierRegion,
  minimumFontPixels,
  entryTransition,
  exitTransition,
  videoSrc,
  durationInFrames = 1,
  palette,
}) => {
  const frame = useCurrentFrame();
  if (
    schemaVersion !== 'proof-presentation/v1' ||
    attribution !== verbalAttribution ||
    JSON.stringify(qualifiers) !== JSON.stringify(verbalQualifiers)
  ) {
    return null;
  }
  const entryOpacity = entryTransition.kind === 'crossfade'
    ? interpolate(
        frame,
        [0, Math.max(1, entryTransition.durationFrames)],
        [0, 1],
        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
      )
    : 1;
  const exitOpacity = exitTransition.kind === 'crossfade'
    ? interpolate(
        frame,
        [
          Math.max(0, durationInFrames - exitTransition.durationFrames),
          durationInFrames,
        ],
        [1, 0],
        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
      )
    : 1;
  const opacity = Math.min(entryOpacity, exitOpacity);
  const creditSize = Math.max(
    minimumFontPixels,
    Math.min(52, Math.round(creditRegion.height * 0.34)),
  );
  const qualifierSize = Math.max(
    minimumFontPixels,
    Math.min(42, Math.round(qualifierRegion.height * 0.3)),
  );
  const proofMedia = (
    <ProofMedia
      sourceMediaType={sourceMediaType}
      evidenceSrc={evidenceSrc}
      sourceStartFrame={sourceStartFrame}
      contextRequired={contextRequired}
    />
  );

  return (
    <AbsoluteFill
      style={{
        backgroundColor: palette.background,
        color: palette.text,
        fontFamily: 'Aptos, Segoe UI, Helvetica, Arial, sans-serif',
        opacity,
        pointerEvents: 'none',
      }}
    >
      {mode === 'cutaway' ? (
        <div
          style={{
            ...regionStyle(evidenceRegion),
            overflow: 'hidden',
            backgroundColor: '#08090B',
          }}
        >
          {proofMedia}
        </div>
      ) : null}

      {mode === 'split-screen' && presenterRegion ? (
        <>
          <div
            style={{
              ...regionStyle(presenterRegion),
              overflow: 'hidden',
              borderRadius: 18,
              backgroundColor: '#08090B',
            }}
          >
            <Presenter videoSrc={videoSrc} />
          </div>
          <div
            style={{
              ...regionStyle(evidenceRegion),
              overflow: 'hidden',
              borderRadius: 18,
              backgroundColor: '#08090B',
              boxShadow: '0 18px 45px rgba(0,0,0,0.35)',
            }}
          >
            {proofMedia}
          </div>
        </>
      ) : null}

      {mode === 'proof-card' ? (
        <>
          <AbsoluteFill style={{ overflow: 'hidden' }}>
            <Presenter videoSrc={videoSrc} />
            <AbsoluteFill style={{ backgroundColor: 'rgba(4,5,8,0.78)' }} />
          </AbsoluteFill>
          <div
            style={{
              position: 'absolute',
              left: Math.max(0, evidenceRegion.x - 20),
              top: Math.max(0, evidenceRegion.y - 20),
              width: evidenceRegion.width + 40,
              height:
                creditRegion.y +
                creditRegion.height -
                evidenceRegion.y +
                40,
              borderRadius: 28,
              background:
                'linear-gradient(145deg, #171A21 0%, #0D0F14 100%)',
              border: `2px solid ${palette.accent}66`,
              boxShadow: '0 24px 80px rgba(0,0,0,0.55)',
            }}
          />
          <div
            style={{
              ...regionStyle(evidenceRegion),
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              gap: Math.max(16, minimumFontPixels * 0.8),
              overflow: 'hidden',
              borderRadius: 24,
              padding: Math.max(28, minimumFontPixels * 1.4),
              boxSizing: 'border-box',
              background: '#11141A',
            }}
          >
            {(sourceMediaType === 'video' || sourceMediaType === 'image') ? (
              <div
                style={{
                  width: '100%',
                  minHeight: 0,
                  flex: '1 1 52%',
                  overflow: 'hidden',
                  borderRadius: 14,
                  backgroundColor: '#08090B',
                }}
              >
                {proofMedia}
              </div>
            ) : null}
            <div
              style={{
                flex: '0 1 auto',
                color: palette.text,
                fontSize: Math.max(minimumFontPixels * 1.15, 28),
                fontWeight: 760,
                lineHeight: 1.13,
                letterSpacing: '-0.025em',
                textAlign: 'center',
              }}
            >
              {claimText}
            </div>
          </div>
        </>
      ) : null}

      <div
        style={{
          ...regionStyle(qualifierRegion),
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxSizing: 'border-box',
          padding: '0 18px',
          borderRadius: 12,
          backgroundColor: 'rgba(5,6,9,0.88)',
          color: '#E8EAF0',
          fontSize: qualifierSize,
          fontWeight: 600,
          lineHeight: 1.15,
          textAlign: 'center',
        }}
      >
        {qualifiers.join(' • ')}
      </div>
      <div
        style={{
          ...regionStyle(creditRegion),
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxSizing: 'border-box',
          padding: '0 18px',
          borderRadius: 12,
          backgroundColor: 'rgba(5,6,9,0.94)',
          borderLeft: `6px solid ${palette.accent}`,
          color: palette.text,
          fontSize: creditSize,
          fontWeight: 800,
          lineHeight: 1.08,
          textAlign: 'center',
        }}
      >
        {attribution}
      </div>
    </AbsoluteFill>
  );
};
