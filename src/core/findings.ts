import type { Finding } from '../shared/types.js';

export const DESIGN_CODES = ['D1', 'D2', 'D3', 'D4', 'D5'] as const;
export const DESIGN_CODE_MEANING: Record<typeof DESIGN_CODES[number], string> = {
  D1: 'Phá ranh giới module hoặc rule dependency đã xác nhận.',
  D2: 'Phá hợp đồng/tương thích API dùng chung và ảnh hưởng consumer.',
  D3: 'Implementation trùng có hành vi mâu thuẫn ở cùng trách nhiệm nghiệp vụ.',
  D4: 'Thêm dependency hoặc đổi cấu hình kiến trúc trái policy.',
  D5: 'Thay đổi thiết kế/refactor vượt phạm vi.',
};

export interface RawFinding {
  category: 'behavior' | 'design'; severity: 'blocker' | 'major' | 'minor'; code?: string;
  title: string; location: string; rule?: string; precedent?: string; evidence: string; suggestion: string;
}
export interface GatedFinding extends RawFinding { downgradedBecause?: string }

/**
 * Design findings may only be blocker/major in the five D-groups, with location, a rule or precedent,
 * impact evidence and a minimal fix. Everything else is minor, so style preferences never open a repair loop.
 */
export function gateFinding(raw: RawFinding): GatedFinding {
  if (raw.severity === 'minor') return raw;
  const missing: string[] = [];
  if (!raw.location.trim()) missing.push('vị trí');
  if (!raw.evidence.trim()) missing.push('bằng chứng ảnh hưởng');
  if (raw.category === 'design') {
    if (!raw.code || !(DESIGN_CODES as readonly string[]).includes(raw.code)) missing.push('mã D1–D5');
    if (!raw.rule?.trim() && !raw.precedent?.trim()) missing.push('rule hoặc tiền lệ');
    if (!raw.suggestion.trim()) missing.push('cách sửa tối thiểu');
  }
  return missing.length ? { ...raw, severity: 'minor', downgradedBecause: `Thiếu ${missing.join(', ')}.` } : raw;
}

/** Open or disputed blocker/major findings stop acceptance until a person resolves them. */
export const blocksCompletion = (f: Pick<Finding, 'severity' | 'status'>): boolean =>
  (f.severity === 'blocker' || f.severity === 'major') && f.status !== 'resolved';

/** Only confirmed findings (runner-reproduced or approved by a person) open an automatic repair round. */
export const opensRepair = (f: Finding, contractVersion: number): boolean =>
  f.confirmed && f.status === 'open' && f.contractVersion === contractVersion && (f.severity === 'blocker' || f.severity === 'major');
