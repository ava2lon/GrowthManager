export function getSafeCallbackDestination(callbackUrl: string | null, origin: string): string {
  if (!callbackUrl) return "/dashboard";

  try {
    const destination = new URL(callbackUrl, origin);
    if (destination.origin !== origin) return "/dashboard";
    if (!destination.pathname.startsWith("/") || destination.pathname.startsWith("//")) return "/dashboard";
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return "/dashboard";
  }
}
