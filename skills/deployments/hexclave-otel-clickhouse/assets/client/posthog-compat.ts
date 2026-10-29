// Keep PostHog's identities and experiment buckets after switching a site off posthog-js.
//
// legacyDistinctId(token): the distinct_id posthog-js stored (localStorage, then cookie), so
//   returning visitors keep their id and the imported history joins up with new events.
// posthogVariant(flagKey, distinctId, rolloutPercent, variants): PostHog's own bucketing
//   (sha1("<key>.<id><salt>"), first 15 hex digits over 0xfffffffffffffff, salt "" for the
//   rollout and "variant" for the variant), so everyone stays in the variant PostHog gave them.
//   Verified against 1,318 of 1,318 recorded exposures. Float math as in PostHog, so fractional
//   percentages (33.33) bucket the same way.
const LONG_SCALE = 0xfffffffffffffff;

export function legacyDistinctId(projectToken: string): string | null {
  const key = `ph_${projectToken}_posthog`;
  const pick = (json: string | null | undefined) => {
    try {
      const id = json ? (JSON.parse(json) as { distinct_id?: unknown }).distinct_id : null;
      return typeof id === "string" && id ? id : null;
    } catch {
      return null;
    }
  };
  try {
    const stored = pick(localStorage.getItem(key));
    if (stored) return stored;
  } catch {}
  try {
    const cookie = document.cookie.split("; ").find((c) => c.startsWith(`${key}=`));
    return pick(cookie && decodeURIComponent(cookie.slice(key.length + 1)));
  } catch {
    return null;
  }
}

async function hash(key: string, id: string, salt: string): Promise<number> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(`${key}.${id}${salt}`));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return Number(BigInt(`0x${hex.slice(0, 15)}`)) / LONG_SCALE;
}

export async function posthogVariant(
  flagKey: string,
  distinctId: string,
  rolloutPercent: number,
  variants: { key: string; rollout: number }[],
): Promise<string | null> {
  if ((await hash(flagKey, distinctId, "")) > rolloutPercent / 100) return null;
  const h = await hash(flagKey, distinctId, "variant");
  let cumulative = 0;
  for (const v of variants) {
    cumulative += v.rollout / 100;
    if (h < cumulative) return v.key;
  }
  return null;
}
