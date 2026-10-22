/** Longest project guidance the API accepts and the prompts render. Long text crowds out the task itself. */
export const GUIDANCE_MAX_CHARS = 4000;

/** Trims, normalises line endings, drops control characters and enforces the cap. */
export function normalizeGuidance(text: string | undefined): string {
  return (text ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, GUIDANCE_MAX_CHARS);
}
