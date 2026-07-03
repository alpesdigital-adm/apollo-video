import React from 'react';
import {
  AbsoluteFill,
  Img,
  OffthreadVideo,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { ColorPalette } from '../lib/types';
import { TEXT_SHADOW, getInsertStyle } from '../components/InsertPrimitives';

type AssetCardStyle = 'credibility' | 'meme' | 'news';

interface AssetCardProps {
  assetId?: string;
  style?: AssetCardStyle;
  name?: string;
  caption?: string;
  imageSrc?: string;
  videoSrc?: string;
  format: '9:16' | '16:9';
  palette: ColorPalette;
  stylePreset?: string;
  durationInFrames?: number;
}

// Darken the palette background so the card reads as its own beat without a
// generic gray panel — the media itself is the subject.
function backdrop(palette: ColorPalette): string {
  return `radial-gradient(120% 120% at 50% 42%, ${palette.background}E6 0%, #05050899 60%, #000000 100%)`;
}

const AssetMedia: React.FC<{
  imageSrc?: string;
  videoSrc?: string;
  radius: number;
  scale: number;
}> = ({ imageSrc, videoSrc, radius, scale }) => {
  const common: React.CSSProperties = {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    borderRadius: radius,
    transform: `scale(${scale})`,
    filter: 'saturate(1.04) contrast(1.03)',
  };
  if (videoSrc) {
    return <OffthreadVideo src={videoSrc} muted style={common} />;
  }
  if (imageSrc) {
    return <Img src={imageSrc} alt="" style={common} />;
  }
  return null;
};

export const AssetCard: React.FC<AssetCardProps> = ({
  style = 'credibility',
  name,
  caption,
  imageSrc,
  videoSrc,
  format,
  palette,
  stylePreset,
  durationInFrames = 40,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const typeface = getInsertStyle(stylePreset).typeface;
  const isVertical = format === '9:16';

  if (!imageSrc && !videoSrc) {
    return null;
  }

  // Fast spring entrance — these cards are ~1-1.5s, made for social-proof bursts.
  const enter = spring({ frame, fps, from: 0, to: 1, durationInFrames: 12, config: { damping: 200 } });
  const opacity = interpolate(
    frame,
    [0, 5, Math.max(6, durationInFrames - 5), durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );
  // Subtle push-in on the media over the card lifetime.
  const mediaScale = interpolate(frame, [0, durationInFrames], [1.02, 1.06], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  if (style === 'news') {
    // Print quase full-width, sombra forte, leve rotação -1º, sem texto extra.
    const width = isVertical ? '92%' : '74%';
    return (
      <AbsoluteFill
        style={{ background: backdrop(palette), opacity, fontFamily: typeface, pointerEvents: 'none' }}
      >
        <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
          <div
            style={{
              width,
              maxHeight: '82%',
              aspectRatio: '4 / 3',
              overflow: 'hidden',
              borderRadius: 10,
              transform: `rotate(-1deg) translateY(${(1 - enter) * 40}px) scale(${0.96 + enter * 0.04})`,
              boxShadow: '0 40px 90px rgba(0,0,0,0.72), 0 8px 24px rgba(0,0,0,0.6)',
              border: '1px solid rgba(255,255,255,0.08)',
            }}
          >
            <AssetMedia imageSrc={imageSrc} videoSrc={videoSrc} radius={10} scale={mediaScale} />
          </div>
        </AbsoluteFill>
      </AbsoluteFill>
    );
  }

  // credibility + meme: card centrado com a mídia; texto abaixo.
  const isCredibility = style === 'credibility';
  const cardWidth = isCredibility ? (isVertical ? '68%' : '46%') : isVertical ? '74%' : '54%';
  const cardAspect = isCredibility ? '4 / 5' : '4 / 3';
  const cardRadius = isCredibility ? 26 : 20;
  const text = isCredibility ? name : caption;
  const textColor = isCredibility ? palette.accent : '#FFFFFF';

  return (
    <AbsoluteFill
      style={{ background: backdrop(palette), opacity, fontFamily: typeface, pointerEvents: 'none' }}
    >
      <AbsoluteFill
        style={{
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          gap: isVertical ? 40 : 30,
          padding: isVertical ? '0 60px' : '0 120px',
        }}
      >
        <div
          style={{
            width: cardWidth,
            aspectRatio: cardAspect,
            overflow: 'hidden',
            borderRadius: cardRadius,
            transform: `translateY(${(1 - enter) * 34}px) scale(${0.9 + enter * 0.1})`,
            boxShadow: '0 30px 70px rgba(0,0,0,0.6), 0 4px 16px rgba(0,0,0,0.5)',
            border: '2px solid rgba(255,255,255,0.10)',
            backgroundColor: '#000000',
          }}
        >
          <AssetMedia imageSrc={imageSrc} videoSrc={videoSrc} radius={cardRadius} scale={mediaScale} />
        </div>

        {text ? (
          <div
            style={{
              transform: `translateY(${(1 - enter) * 20}px)`,
              opacity: enter,
              color: textColor,
              fontSize: isVertical ? (isCredibility ? 56 : 46) : isCredibility ? 46 : 40,
              fontWeight: 800,
              letterSpacing: '-0.02em',
              lineHeight: 1.06,
              textAlign: 'center',
              textShadow: TEXT_SHADOW,
              maxWidth: '90%',
            }}
          >
            {text}
          </div>
        ) : null}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
