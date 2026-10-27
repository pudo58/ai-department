export const TEMPLATE_DIR: string;
export function buildExporter(options?: { outDir?: string }): Promise<{ outDir: string; codeSha: string }>;
export function prepareBundle(options: { templateDir?: string; outDir: string; origin: string }): {
  pluginVersion: string; protocolVersion: number; readerVersion: number; origin: string; bundleHash: string; files: Record<string, string>;
};
export function verifyBundle(dir: string): {
  ok: boolean; problems: string[];
  info: { pluginVersion: string; protocolVersion: number; readerVersion: number; origin: string; bundleHash: string; files: Record<string, string> } | undefined;
};
export function copyTemplate(from: string, to: string): void;
