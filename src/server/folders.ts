import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export interface FolderEntry { name: string; path: string; git: boolean; node: boolean }
export interface FolderPlace { label: string; path: string }
export interface FolderListing { path: string; parent: string | null; folders: FolderEntry[]; truncated: boolean; places: FolderPlace[] }

/** Folders nobody picks as a project; dot folders are skipped as well. */
const SKIP = new Set(['node_modules', '$RECYCLE.BIN', 'System Volume Information']);
const MAX_FOLDERS = 500;

/** Starting points for the picker: the home folder and its usual children, then the drives (Windows) or the root. */
export function folderPlaces(platform: NodeJS.Platform = process.platform): FolderPlace[] {
  const home = homedir();
  const places: FolderPlace[] = [{ label: 'Thư mục người dùng', path: home }];
  for (const name of ['Desktop', 'Documents', 'Downloads']) {
    const p = path.join(home, name);
    if (existsSync(p)) places.push({ label: name, path: p });
  }
  if (platform === 'win32') {
    // A: and B: are floppy letters; probing them can stall.
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') if (existsSync(`${letter}:\\`)) places.push({ label: `Ổ ${letter}:`, path: `${letter}:\\` });
  } else places.push({ label: 'Gốc /', path: '/' });
  return places;
}

/**
 * The sub-folders of one folder, for choosing a project folder. Only directory names are returned, never file
 * contents; each folder is marked when it holds a git repository or a package.json so projects stand out.
 */
export async function listFolders(asked?: string): Promise<FolderListing> {
  const target = path.resolve(asked?.trim() || homedir());
  let entries;
  try { entries = await readdir(target, { withFileTypes: true }); }
  catch { throw Object.assign(new Error('Không mở được thư mục này: không tồn tại hoặc không có quyền đọc.'), { statusCode: 400 }); }
  const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'vi', { sensitivity: 'base', numeric: true }));
  const folders = dirs.slice(0, MAX_FOLDERS).map((e) => {
    const p = path.join(target, e.name);
    return { name: e.name, path: p, git: existsSync(path.join(p, '.git')), node: existsSync(path.join(p, 'package.json')) };
  });
  const parent = path.dirname(target);
  return { path: target, parent: parent === target ? null : parent, folders, truncated: dirs.length > MAX_FOLDERS, places: folderPlaces() };
}
