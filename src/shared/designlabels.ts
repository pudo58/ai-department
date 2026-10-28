import type { ExportCoverage, SourceIdentity } from './design.js';
import type { ExportIssue } from './figma.js';

export interface CoverageLabel { text: string; limited: boolean }
/** Human wording for confirmation; the original API message remains available for diagnosis. */
export function issueLabel(issue: ExportIssue): string {
  if (issue.code === 'field_error' && issue.field === 'instance.componentProperties') return 'Chưa đọc được cấu hình property/variant của một số component. Xem danh sách instance và component gốc trong Chi tiết cảnh báo.';
  if (issue.code === 'asset_missing' && issue.field === 'asset') return 'Một số tài nguyên chưa xuất được. Xem phân loại SVG đang ẩn và SVG cần kiểm tra trong Chi tiết cảnh báo.';
  if (issue.code === 'source_user_attested') return 'Xác nhận đây là đúng file Figma bạn muốn dùng. Plugin hiện không cung cấp file key để đối chiếu nguồn tự động.';
  return issue.message;
}
/** The words the page uses. "Đã đọc đủ cấu trúc trong phạm vi" and "Có giới hạn" are the only two; neither says the design was understood. */
export function coverageLabel(_coverage: ExportCoverage, issues: readonly ExportIssue[]): CoverageLabel {
  const limited = issues.some((i) => i.severity === 'limit');
  return { limited, text: limited ? 'Có giới hạn' : 'Đã đọc đủ cấu trúc trong phạm vi' };
}

export const identityLabel = (identity: SourceIdentity): string => (identity === 'verified' ? 'Nguồn đã đối chiếu file key' : 'Nguồn do người dùng xác nhận (chưa đối chiếu tự động)');
