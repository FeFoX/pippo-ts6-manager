/** Number fields in Settings → Download & Stream Limits. The ranges mirror what the backend accepts. */

export const MAX_SEEK_COOLDOWN_SECONDS = 86400;
export const MAX_RESUME_COOLDOWN_SECONDS = 3600;
export const MIN_PLAYLIST_IMPORT = 1;
export const MAX_PLAYLIST_IMPORT = 500;

/** A whole number from min to max (no upper bound when max is omitted), or null for anything else, including an empty field. */
export function parseWholeNumber(text: string, min: number, max = Number.MAX_SAFE_INTEGER): number | null {
  const s = text.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = parseInt(s, 10);
  return n >= min && n <= max ? n : null;
}

export const parseSeekCooldownInput = (text: string) => parseWholeNumber(text, 0, MAX_SEEK_COOLDOWN_SECONDS);
export const parseResumeCooldownInput = (text: string) => parseWholeNumber(text, 0, MAX_RESUME_COOLDOWN_SECONDS);
export const parseMaxVideoDurationInput = (text: string) => parseWholeNumber(text, 0);
export const parseMaxPlaylistImportInput = (text: string) =>
  parseWholeNumber(text, MIN_PLAYLIST_IMPORT, MAX_PLAYLIST_IMPORT);
