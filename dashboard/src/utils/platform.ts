/** True when the visitor's computer runs Windows (decides which install way the portal shows first). */
export function isWindowsVisitor(): boolean {
  if (typeof navigator === 'undefined') return false;
  const hinted = (navigator as any).userAgentData?.platform as string | undefined;
  const text = (hinted || navigator.platform || navigator.userAgent || '').toLowerCase();
  return text.includes('win');
}
