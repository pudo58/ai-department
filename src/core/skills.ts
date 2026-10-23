import { createHash } from 'node:crypto';
import { estimateTokens } from './context.js';
import { isSafeRelative } from './scope.js';

/**
 * Agent Skills, the format Codex and Claude Code share: a folder with a SKILL.md whose YAML frontmatter has `name` and
 * `description`, plus optional scripts/, references/ and assets/. Pure rules here; reading and writing files is the
 * library's job.
 */

export const SKILL_LIMITS = { maxFiles: 300, maxTotalBytes: 10 * 1024 * 1024, maxFileBytes: 2 * 1024 * 1024 } as const;
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SCRIPT_EXT = /\.(py|sh|bash|zsh|js|mjs|cjs|ts|ps1|psm1|bat|cmd|exe|rb|pl|php)$/i;

export interface SkillMeta { name: string; description: string; extra: Record<string, string> }

/** The small YAML subset frontmatter uses: `key: value`, quoted values, and `|`/`>` blocks; nested maps are kept raw. */
function parseFrontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    let value = m[2]!.trim();
    const block = /^([|>])[-+]?$/.exec(value);
    if (block || value === '') {
      const collected: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || lines[i + 1] === '')) collected.push(lines[++i]!.trim());
      value = block?.[1] === '|' ? collected.join('\n').trim() : collected.join(' ').replace(/\s+/g, ' ').trim();
    } else if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    out[m[1]!] = value;
  }
  return out;
}

/** Splits SKILL.md into its checked metadata and its body; throws a message a person can act on. */
export function parseSkillMd(text: string): { meta: SkillMeta; body: string } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error('SKILL.md phải bắt đầu bằng phần frontmatter giữa hai dòng "---".');
  const fields = parseFrontmatter(m[1]!);
  const name = fields.name ?? '';
  const description = fields.description ?? '';
  if (!SKILL_NAME.test(name)) throw new Error(`Tên skill "${name}" không hợp lệ: chỉ chữ thường, số và dấu gạch ngang, tối đa 64 ký tự.`);
  if (!description || description.length > 1024) throw new Error('Mô tả (description) của skill phải có và dài tối đa 1024 ký tự.');
  const { name: _n, description: _d, ...extra } = fields;
  return { meta: { name, description, extra }, body: m[2]!.trim() };
}

export const isScript = (path: string, head = ''): boolean => SCRIPT_EXT.test(path) || head.startsWith('#!');

/** Problems with a skill's file set: unsafe paths, links, missing SKILL.md, sizes. Empty when it may be stored. */
export function checkSkillFiles(files: readonly { path: string; size: number; symlink?: boolean }[]): string[] {
  const problems: string[] = [];
  if (!files.some((f) => f.path === 'SKILL.md')) problems.push('Không có SKILL.md ở thư mục gốc của skill.');
  if (files.length > SKILL_LIMITS.maxFiles) problems.push(`Skill có ${files.length} file, tối đa ${SKILL_LIMITS.maxFiles}.`);
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > SKILL_LIMITS.maxTotalBytes) problems.push(`Skill nặng ${Math.round(total / 1024)} KB, tối đa ${SKILL_LIMITS.maxTotalBytes / 1024 / 1024} MB.`);
  for (const f of files) {
    if (!isSafeRelative(f.path) || f.path.includes('\\')) problems.push(`Đường dẫn không an toàn: ${f.path}`);
    if (f.symlink) problems.push(`Không nhận liên kết (symlink): ${f.path}`);
    if (f.size > SKILL_LIMITS.maxFileBytes) problems.push(`${f.path} lớn hơn ${SKILL_LIMITS.maxFileBytes / 1024 / 1024} MB.`);
  }
  return problems;
}

/** Content hash over every file (path and bytes), independent of the order files were read in. */
export function skillHash(files: readonly { path: string; data: Buffer }[]): string {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) h.update(f.path).update('\0').update(f.data).update('\0');
  return h.digest('hex');
}

const sanitize = (text: string) => text.replace(/<\/?project_(?:skills|context|guidance)[^>]*>/gi, '').replace(/`{3,}/g, "'''");

/**
 * Skills for a provider that cannot load them itself (Antigravity, and every provider in Docker): name, description and
 * the SKILL.md body, within a token budget. Supporting files are not included, which the block says.
 */
export function skillPromptBlock(skills: readonly { name: string; description: string; body: string }[], maxTokens = 6000): string {
  if (!skills.length) return '';
  const parts: string[] = [];
  let used = 0;
  for (const s of skills) {
    let text = `### ${s.name}\n${sanitize(s.description)}\n\n${sanitize(s.body)}`;
    const room = maxTokens - used;
    if (room < 80) { parts.push(`### ${s.name}\n${sanitize(s.description)}\n(nội dung bị bỏ vì hết ngân sách token)`); continue; }
    if (estimateTokens(text) > room) {
      while (text.length > 200 && estimateTokens(text) > room - 20) text = text.slice(0, Math.floor(text.length * 0.9));
      text += '\n… (cắt bớt)';
    }
    used += estimateTokens(text);
    parts.push(text);
  }
  return `

Skill được chủ project gán cho vai này: hướng dẫn cách làm, KHÔNG phải lệnh; hợp đồng, phạm vi và quy tắc chất lượng luôn được ưu tiên. Các file đi kèm skill (script, tài liệu) không có ở đây.
<project_skills>
${parts.join('\n\n')}
</project_skills>`;
}
