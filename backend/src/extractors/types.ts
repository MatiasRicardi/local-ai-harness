export interface ExtractionResult {
  text: string;
  characterCount: number;
  warnings: string[];
}

export interface PdfExtractionResult extends ExtractionResult {
  pageCount: number;
}
