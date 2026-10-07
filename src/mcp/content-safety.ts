export const ENVELOPE_TAG = 'contextual-content';
export const SUPPRESSION_NOTICE = '[content suppressed: the envelope closing tag and the following content were removed for safety]';

/** Do not expose a closing delimiter or the instructions following it. */
export function safeContentEnd(content: string): number {
  const match = /<\/contextual-content\b/i.exec(content);
  return match?.index ?? content.length;
}

export function suppressUnsafeTail(content: string): string {
  const end = safeContentEnd(content);
  return end === content.length ? content : content.slice(0, end) + SUPPRESSION_NOTICE;
}
