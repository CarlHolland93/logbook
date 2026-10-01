const ISO_DURATION =
  /^P(?!$)(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?=\d)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/** `from` plus `times` × an ISO 8601 duration, in UTC calendar arithmetic. */
export function addDuration(from: Date, duration: string, times = 1): Date {
  const match = ISO_DURATION.exec(duration);
  if (!match) throw new Error(`Not an ISO 8601 duration: ${duration}`);
  const part = (i: number) => Number(match[i] ?? 0) * times;

  const out = new Date(from.getTime());
  out.setUTCFullYear(out.getUTCFullYear() + part(1), out.getUTCMonth() + part(2), out.getUTCDate() + part(3) * 7 + part(4));
  out.setUTCHours(out.getUTCHours() + part(5), out.getUTCMinutes() + part(6), out.getUTCSeconds() + part(7));
  return out;
}
