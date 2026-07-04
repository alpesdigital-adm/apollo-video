import React from 'react';
import { SubtitleEntry, ColorPalette, LayoutSegment, SubtitleStyle } from '../lib/types';
import { SubtitleTikTok } from './SubtitleTikTok';
import { SubtitleStandard } from './SubtitleStandard';
import { findActiveLayoutSegment } from './LayoutSegmentLayer';
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
}) => {
  const frame = useCurrentFrame();
  const config = useVideoConfig();
  const currentTime = frame / config.fps;
  const activeSegment = findActiveLayoutSegment(layoutSegments, frame);

  const currentSubtitle = subtitles.find(
    (sub) => {
      if (typeof sub.startFrame === 'number' && typeof sub.endFrame === 'number') {
        return frame >= sub.startFrame && frame < sub.endFrame;
      }

      return currentTime >= sub.startTime && currentTime < sub.endTime;
    }
  );

  if (!currentSubtitle) {
    return null;
  }

  if (format === '9:16') {
    // split-50's centered two-word mode keeps precedence — it is already on the
    // seam and must not be displaced.
    if (activeSegment?.layout === 'split-50') {
      return (
        <SubtitleTikTok
          subtitle={currentSubtitle}
          palette={palette}
          isVisible={!!currentSubtitle}
          mode="two-word-center"
          subtitleStyle={subtitleStyle}
        />
      );
    }

    const hf = Math.max(0, Math.min(1, hideFactor));
    if (hf >= 1) {
      return null;
    }
    // Camada 2: quando nenhuma regra de composição forçou o topo, a âncora por
    // batida (vision) decide. Combinada por max com o topFactor de composição —
    // palco (top) e âncora concordam; a âncora nunca sobrepõe split-50/hide
    // (que já saíram acima) nem rebaixa uma cena de palco.
    const anchorTop = currentSubtitle.anchor === 'top' ? 1 : 0;
    const tf = Math.max(0, Math.min(1, Math.max(topFactor, anchorTop)));
    const visible = 1 - hf;
    // Troca SEQUENCIAL de posição: a cópia de baixo apaga POR COMPLETO antes de
    // a de cima acender (e vice-versa). O crossfade anterior renderizava as duas
    // cópias legíveis ao mesmo tempo por ~8 frames em toda troca — lia como
    // "legenda duplicada" (visto em still real na emenda do cold open).
    const bottomOpacity = tf < 0.5 ? (1 - tf * 2) * visible : 0;
    const topOpacity = tf >= 0.5 ? (tf - 0.5) * 2 * visible : 0;
    return (
      <>
        {bottomOpacity > 0.01 && (
          <SubtitleTikTok
            subtitle={currentSubtitle}
            palette={palette}
            isVisible={!!currentSubtitle}
            mode="default"
            subtitleStyle={subtitleStyle}
            placement="bottom"
            placementOpacity={bottomOpacity}
          />
        )}
        {topOpacity > 0.01 && (
          <SubtitleTikTok
            subtitle={currentSubtitle}
            palette={palette}
            isVisible={!!currentSubtitle}
            mode="default"
            subtitleStyle={subtitleStyle}
            placement="top"
            placementOpacity={topOpacity}
          />
        )}
      </>
    );
  }

  return (
    <SubtitleStandard
      subtitle={currentSubtitle}
      palette={palette}
      isVisible={!!currentSubtitle}
    />
  );
};
