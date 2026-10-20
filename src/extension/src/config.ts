// CLI scripts only. The extension reads its RPC from popup settings.
const runtime = globalThis as { process?: { env?: { QUICKNODE_RPC?: string } } };
export const QUICKNODE_RPC = runtime.process?.env?.QUICKNODE_RPC?.trim() ?? "";
