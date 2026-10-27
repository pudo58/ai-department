import type { ExportCoverage, SourceIdentity } from './design.js';
import type { ExportIssue } from './figma.js';

export interface CoverageLabel { text: string; limited: boolean }
/** The words the page uses. "Đã đọc đủ cấu trúc trong phạm vi" and "Có giới hạn" are the only two; neither says the design was understood. */
export function coverageLabel(_coverage: ExportCoverage, issues: readonly ExportIssue[]): CoverageLabel {
  const limited = issues.some((i) => i.severity === 'limit');
  return { limited, text: limited ? 'Có giới hạn' : 'Đã đọc đủ cấu trúc trong phạm vi' };
}

export const identityLabel = (identity: SourceIdentity): string => (identity === 'verified' ? 'Nguồn đã đối chiếu file key' : 'Nguồn do người dùng xác nhận (chưa đối chiếu tự động)');
