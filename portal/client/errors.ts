import { isSolanaError } from '@solana/kit';

/**
 * Human-readable message for any error. Kit's production build strips
 * SolanaError messages, so fall back to its code and context.
 */
export function describeError(error: unknown): string {
  if (isSolanaError(error)) {
    const context = error.context as Record<string, unknown> & { __code: number };
    if (context.statusCode === 429) return 'Solana RPC rate limit hit (HTTP 429). Wait a few seconds and retry, or set a dedicated RPC_URL.';
    if (typeof context.statusCode === 'number') return `Solana RPC request failed (HTTP ${context.statusCode}).`;
    if (error.cause) return describeError(error.cause);
    const detail = Object.entries(context)
      .filter(([k]) => k !== '__code')
      .map(([k, v]) => `${k}=${typeof v === 'bigint' ? v.toString() : JSON.stringify(v)}`)
      .join(' ');
    return `Solana error ${context.__code}${detail ? ` (${detail})` : ''}`;
  }
  return error instanceof Error ? error.message : String(error);
}
