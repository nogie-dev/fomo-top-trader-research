import type { Callout } from "../shared/types";
import { isSolanaAddress } from "../shared/solana";

const API = "https://frontend-api-v3.pump.fun";
type ProfileCallout = {
  calloutId: string;
  coinMint: string;
  createdAt: number;
  calloutPrice?: number;
  calloutPriceUsd?: number;
};
type CoinInfo = { mint: string; name?: string; symbol?: string; created_timestamp?: number };

// Fetch one page; the picker requests older history only when Load more is clicked.
export async function readCalloutPage(wallet: string, pageToken: string, signal: AbortSignal): Promise<{ callouts: Callout[]; nextPageToken: string }> {
  const url = new URL(`${API}/callout/list/${encodeURIComponent(wallet)}`);
  url.search = new URLSearchParams({ limit: "20", sortBy: "TIMESTAMP", sortOrder: "DESC" }).toString();
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Pump.fun callout history returned HTTP ${response.status}.`);
  const body = await response.json() as { callouts?: ProfileCallout[]; nextPageToken?: string } | null;
  if (!Array.isArray(body?.callouts) || typeof body.nextPageToken !== "string") throw new Error("Unexpected Pump.fun callout history response.");
  const history = new Map<string, Callout>();
  for (const row of body.callouts) {
    if (!row || typeof row.calloutId !== "string" || !row.calloutId || typeof row.coinMint !== "string"
      || (!isSolanaAddress(row.coinMint) && !/^0x[0-9a-fA-F]{40}$/.test(row.coinMint))
      || typeof row.createdAt !== "number" || !Number.isFinite(new Date(row.createdAt).getTime())) throw new Error("Invalid Pump.fun callout.");
    history.set(row.calloutId, {
      sourceId: row.calloutId, mint: row.coinMint, at: new Date(row.createdAt).toISOString(), source: "pumpfun",
      calloutPrice: row.calloutPrice, calloutPriceUsd: row.calloutPriceUsd,
      url: `https://pump.fun/callouts/${row.coinMint}/${encodeURIComponent(row.calloutId)}`,
    });
  }
  const callouts = [...history.values()].sort((a, b) => Date.parse(b.at!) - Date.parse(a.at!));
  const mints = [...new Set(callouts.map(({ mint }) => mint).filter(isSolanaAddress))];
  if (mints.length) {
    try {
      const metadata = await fetch(`${API}/coins-v2/mints`, {
        method: "POST", headers: { accept: "application/json", "content-type": "application/json" },
        credentials: "include", body: JSON.stringify({ mints }), signal,
      });
      if (metadata.ok) {
        const coins = await metadata.json() as CoinInfo[];
        if (Array.isArray(coins)) {
          const byMint = new Map(coins.filter((coin) => coin && typeof coin.mint === "string").map((coin) => [coin.mint, coin]));
          for (const callout of callouts) {
            const coin = byMint.get(callout.mint);
            if (!coin) continue;
            if (typeof coin.name === "string") callout.tokenName = coin.name;
            if (typeof coin.symbol === "string") callout.symbol = coin.symbol;
            if (typeof coin.created_timestamp === "number" && Number.isFinite(new Date(coin.created_timestamp).getTime())) {
              callout.tokenCreatedAt = new Date(coin.created_timestamp).toISOString();
            }
          }
        }
      }
    } catch (error) {
      if (signal.aborted) throw error;
      // A missing token label must not prevent selecting a callout by mint.
    }
  }
  return { callouts, nextPageToken: body.nextPageToken };
}
