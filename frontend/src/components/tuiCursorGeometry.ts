export interface TuiCursorGeometryInput {
  borderLeft: number;
  borderTop: number;
  paddingLeft: number;
  paddingRight: number;
  paddingTop: number;
  paddingBottom: number;
  clientHeight: number;
  clientWidth: number;
  scrollLeft: number;
  textBeforeCursorWidth: number;
  fullTextWidth?: number;
  textAlign: string;
}

export interface TuiCursorGeometry {
  left: number;
  top: number;
  height: number;
}

/**
 * Position the block cursor in the input's text content box, not its border
 * box. The browser scrolls an overflowing input independently of its wrapper,
 * so the measured insertion position must be translated by `scrollLeft`.
 */
export function getTuiCursorGeometry({
  borderLeft,
  borderTop,
  paddingLeft,
  paddingRight,
  paddingTop,
  paddingBottom,
  clientHeight,
  clientWidth,
  scrollLeft,
  textBeforeCursorWidth,
  fullTextWidth = 0,
  textAlign,
}: TuiCursorGeometryInput): TuiCursorGeometry {
  const contentWidth = clientWidth - paddingLeft - paddingRight;
  const alignmentOffset =
    textAlign === 'center' ? (contentWidth - fullTextWidth) / 2 : 0;

  return {
    left:
      borderLeft +
      paddingLeft +
      alignmentOffset +
      textBeforeCursorWidth -
      scrollLeft,
    top: borderTop + paddingTop,
    height: Math.max(1, clientHeight - paddingTop - paddingBottom),
  };
}
