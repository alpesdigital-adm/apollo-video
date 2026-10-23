/** OCR observations for the image-library tests. Test content, not product: the library reads the text of each real image. */
export const IMAGE_EVAL_FIXTURES = Object.freeze([
  { id: 'no-text', ocr: [], expected: 'sem texto detectado' },
  { id: 'small-text', ocr: [{ text: 'Oferta válida hoje', language: 'pt-BR', box: [0.7, 0.8, 0.2, 0.05], confidence: 0.61 }], expected: 'Oferta válida hoje' },
  { id: 'multilingual', ocr: [{ text: 'Olá', language: 'pt-BR', box: [0, 0, 0.2, 0.1], confidence: 0.97 }, { text: 'Welcome', language: 'en', box: [0, 0.2, 0.3, 0.1], confidence: 0.96 }], expected: 'Welcome' },
])
