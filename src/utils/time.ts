/** Convert "HH:MM:SS(.mmm)" or "MM:SS" to seconds as float. */
export function hmsToSeconds(hms: string): number {
  const parts = hms.split(':').map(Number);
  const [h, m, s] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
  return h * 3600 + m * 60 + s;
}
