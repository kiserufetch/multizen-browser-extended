/**
 * Lightweight className join. We avoid clsx to keep deps minimal.
 */
export function cn(...args: Array<string | false | null | undefined>): string {
  return args.filter(Boolean).join(" ");
}
