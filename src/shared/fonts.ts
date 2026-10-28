/** The fonts a design uses, and what was fetched for them. Open fonts only: a commercial font is reported as missing, never guessed. */

export interface FontVariant { weight: number; italic: boolean }
/** One family as the snapshot's text nodes use it. */
export interface FontUse { family: string; variants: FontVariant[]; nodes: number }

export interface FontFile {
  /** Relative to the font store's files folder: `<id>@<version>/<name>`. */
  file: string; name: string; family: string; weight: number; italic: boolean; subset: string; sha256: string; bytes: number;
}
export type FontStatus = 'ready' | 'not_open' | 'failed';
export interface FontFamilyResult {
  family: string; status: FontStatus; id?: string; license?: string; version?: string; source?: string;
  files: FontFile[]; notes: string[];
  /** `unicode-range` per subset, from the catalogue, so the generated @font-face needs no guesswork. */
  unicodeRange?: Record<string, string>;
}
export interface FontSet {
  schemaVersion: 1; snapshotId: string; snapshotHash: string; fetchedAt: string; families: FontFamilyResult[];
}
export interface SnapshotFonts {
  uses: FontUse[];
  set?: FontSet;
  /** The only hosts a font is ever fetched from. */
  hosts: readonly string[];
}

/** Where fonts may be fetched from: the catalogue's API and the CDN that serves its pinned package. Nothing else, whatever a redirect says. */
export const FONT_HOSTS = ['api.fontsource.org', 'cdn.jsdelivr.net'] as const;
/** Latin, Latin Extended and Vietnamese: what a Vietnamese interface needs, and nothing it does not. */
export const FONT_SUBSETS = ['latin', 'latin-ext', 'vietnamese'] as const;
