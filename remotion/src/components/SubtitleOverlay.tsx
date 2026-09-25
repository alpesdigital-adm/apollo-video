import React from 'react';
import { SubtitleEntry, ColorPalette, LayoutSegment, SubtitleStyle } from '../lib/types';
import type { SubtitleMvpFormat, SubtitleStylePreset } from '../../../src/v2/domain/subtitle-style-tokens';
import { SubtitleTikTok } from './SubtitleTikTok';
import { findActiveLayoutSegment } from './LayoutSegmentLayer';
import { resolveActiveSubtitleLayers } from '../lib/subtitle-overlay-selection';
import { useCurrentFrame, useVideoConfig } from 'remotion';

interface SubtitleOverlayProps {
  subtitles: SubtitleEntry[];
  format: '9:16' | '16:9';
  palette: ColorPalette;
  layoutSegments?: LayoutSegment[];
  subtitleStyle?: SubtitleStyle;
  // 0-1. 1 = a stage typographic scene owns the frame, so the karaoke subtitle
  // displaces to the TOP of the head (never colliding with the centered
  // statement); 0 = normal bottom placement. Values in between = the ~8-frame
  // positional crossfade (bottom fades out / top fades in). Defaults to 0.
  topFactor?: number;
  // 0-1. 1 = uma camada de LEITURA full-canvas (tweet-card) está ativa e a
  // legenda se ESCONDE por completo (o card é o texto do momento). Defaults 0.
  hideFactor?: number;
  fontFamily?: 'ApolloResourceFont';
  subtitlePreset?: SubtitleStylePreset;
  subtitleFormat?: SubtitleMvpFormat;
}

// LEI DE COORDENAÇÃO DA LEGENDA (matriz única — casos novos entram AQUI, nunca
// como patch em outro lugar):
//   split-50 ativo            → modo two-word na costura (precedência máxima)
//   tweet-card ativo          → legenda ESCONDIDA (hideFactor; o card já é a leitura)
//   cena tipográfica de palco → legenda no TOPO (topFactor; manchete se esconde
//                               nessas cenas por exclusividade, o topo fica livre)
//   ÂNCORA DA BATIDA (Camada 2) → 'top' quando o rosto/ação dominante está no
//                               terço de BAIXO do frame real (vision no thumbnail,
//                               currentSubtitle.anchor). Só decide quando NENHUMA
//                               regra de composição acima mandou (é o penúltimo).
//   resto (narrador, b-roll, AssetCard, blur-bg) → RODAPÉ padrão
// Precedência: split-50 (costura) > tweet-hide > palco (top) > âncora da batida
// > rodapé. Implementada abaixo: split-50 e hide fazem short-circuit; o topFactor
// efetivo = max(topFactor de composição, âncora 'top'), então palco e âncora
// concordam no topo e a âncora nunca sobrepõe uma regra de composição.

export const SubtitleOverlay: React.FC<SubtitleOverlayProps> = ({
  subtitles,
  format,
  palette,
  layoutSegments,
  subtitleStyle,
  topFactor = 0,
  hideFactor = 0,
  fontFamily,
  subtitlePreset,
  subtitleFormat,
}) => {
  const frame = useCurrentFrame();
  const config = useVideoConfig();
  const activeSegment = findActiveLayoutSegment(layoutSegments, frame);
  const layers = resolveActiveSubtitleLayers({
    subtitles,
    frame,
    fps: config.fps,
    format,
    activeLayout: activeSegment?.layout,
    topFactor,
    hideFactor,
  });

  return layers.length === 0 ? null : (
    <>
      {layers.map((layer) => (
        <SubtitleTikTok
          key={`${layer.sourceIndex}:${layer.placement}`}
          subtitle={layer.subtitle}
          palette={palette}
          isVisible
          mode={layer.mode}
          subtitleStyle={subtitleStyle}
          placement={layer.placement === 'center' ? undefined : layer.placement}
          placementOpacity={layer.placementOpacity}
          fontFamily={fontFamily}
          subtitlePreset={subtitlePreset!}
          subtitleFormat={subtitleFormat!}
        />
      ))}
    </>
  );
};
