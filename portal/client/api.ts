// Calls to the portal server (never the oracle directly).
export type PortalConfig = { cluster: 'localnet' | 'devnet'; rpcUrl: string; mint: string; demoKyc: boolean; demoFaucet: boolean };

export type Job = { id: number; status: string; action: string | null; signature: string | null; lastError: string | null };
export type Status = {
  email: string;
  applicantId: string;
  applicant: { status: string; tier: number | null; jurisdiction: number | null; kycExpiry: string | null } | null;
  wallets: { address: string; linkedAt: string; job: Job | null }[];
};

const TOKEN_KEY = 'gatehook.portal.session';

export const session = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (token: string) => localStorage.setItem(TOKEN_KEY, token),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = session.get();
  const res = await fetch(path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok) throw new Error(json.message ?? `Request failed (${res.status})`);
  return json as T;
}

export const api = {
  config: () => call<PortalConfig>('GET', '/api/config'),
  signIn: (email: string) => call<{ token: string }>('POST', '/api/session', { email }),
  status: () => call<Status>('GET', '/api/status'),
  kyc: (body: { status: 'approved' | 'revoked'; tier?: string; country?: string }) => call<{ result: string }>('POST', '/api/kyc', body),
  challenge: (wallet: string) => call<{ nonce: string; message: string }>('POST', '/api/wallet/challenge', { wallet }),
  link: (wallet: string, nonce: string, signature: string) => call('POST', '/api/wallet/link', { wallet, nonce, signature }),
  faucet: (wallet: string) => call<{ signature: string }>('POST', '/api/demo/faucet', { wallet }),
};
