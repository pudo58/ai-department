import { z } from 'zod';

export const VisualProfileSchema = z.object({
  pathTemplate: z.string().trim().min(1).max(500).refine(p => p.startsWith('/') && !p.startsWith('//') && !/[\\\r\n]/.test(p), 'Dùng đường dẫn trong ứng dụng, ví dụ /?state={nodeId}.'),
  readySelector: z.string().trim().min(1).max(300).optional(),
  maxDiffRatio: z.number().min(0).max(0.2).optional(),
  pixelThreshold: z.number().min(0).max(0.3).default(0.1),
  screens: z.array(z.object({ nodeId: z.string().regex(/^\d+:\d+$/), selector: z.string().trim().min(1).max(300).optional(), viewport: z.object({ width: z.number().int().min(100).max(4096), height: z.number().int().min(100).max(4096) }).optional() }).strict()).min(1).max(30).refine(list => new Set(list.map(s => s.nodeId)).size === list.length, 'Không lặp node trong profile.').optional(),
}).strict();
