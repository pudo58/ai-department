import type { Mode } from '../shared/types.js';

export const RISK_SIGNALS = ['ambiguity', 'permissions', 'concurrency', 'public-api', 'alternatives'] as const;
export type RiskSignal = typeof RISK_SIGNALS[number];

/** Cost multiplier relative to the Single configuration. Team is capped at 3x (see budget.ts). */
export const MODE_MULTIPLIER: Record<Mode, number> = { single: 1, clarify: 1.4, verify: 1.8, compare: 2.2 };

export interface Recommendation { mode: Mode; reasons: string[]; multiplier: number }

/** Explicit rules, no learned router. Team is only ever proposed; the user chooses. */
export function recommendMode(signals: readonly string[]): Recommendation {
  const has = (s: RiskSignal) => signals.includes(s);
  const reasons: string[] = [];
  let mode: Mode = 'single';
  if (has('ambiguity')) {
    mode = 'clarify';
    reasons.push('Yêu cầu còn câu hỏi chưa giải quyết hoặc ví dụ mâu thuẫn: cần diễn giải độc lập.');
  } else if (has('permissions') || has('concurrency') || has('public-api')) {
    mode = 'verify';
    if (has('permissions')) reasons.push('Thay đổi quyền truy cập: logic quan trọng, khó phát hiện hồi quy.');
    if (has('concurrency')) reasons.push('Retry/concurrency hoặc tính nhất quán dữ liệu: nên kiểm chứng độc lập.');
    if (has('public-api')) reasons.push('Public API dùng chung: consumer có thể bị ảnh hưởng.');
  } else if (has('alternatives')) {
    mode = 'compare';
    reasons.push('Có hai giả thuyết/thiết kế chưa phân biệt được bằng kiểm tra rẻ.');
  }
  if (mode === 'single') reasons.push('Không có dấu hiệu rủi ro đã đăng ký: giữ Single.');
  return { mode, reasons, multiplier: MODE_MULTIPLIER[mode] };
}
