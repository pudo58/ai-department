// Builds the Figma Exporter plugin template into plugins/figma-exporter/dist (part of `pnpm build`).
//   node scripts/build-figma-exporter.mjs
import { buildExporter } from '../plugins/figma-exporter/build.mjs';

const { outDir, codeSha } = await buildExporter();
console.log(`✓ Exporter dựng xong: ${outDir} (code.js ${codeSha.slice(0, 12)})`);
