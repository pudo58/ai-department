/** Install existing dependencies without introducing or rewriting source files during setup. */
export function planNpmSetup(command: readonly string[], hasLockfile: boolean): { command: string[]; note?: string } {
  const [exe, action, ...options] = command;
  const safeOptions = new Set(['--no-audit', '--no-fund', '--ignore-scripts', '--offline', '--prefer-offline']);
  // Explicit package additions, workspace/prefix commands and custom flags keep their approved meaning.
  if (!['npm', 'npm.cmd'].includes(exe ?? '') || !['install', 'i'].includes(action ?? '') || options.some(arg => !safeOptions.has(arg))) return { command: [...command] };
  return hasLockfile
    ? { command: [exe!, 'ci', ...options], note: 'Setup dùng npm ci theo lockfile của snapshot, không cập nhật dependency hoặc lockfile.' }
    : { command: [exe!, 'install', '--package-lock=false', ...options], note: 'Snapshot chưa có lockfile: setup không tạo package-lock.json. Phiên bản dependency chưa được ghim; thêm lockfile vào repository để cài đặt tái lập.' };
}
