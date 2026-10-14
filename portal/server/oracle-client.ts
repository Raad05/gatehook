/** Thin client for the oracle's internal API. */
export class OracleError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type OracleApplicant = {
  applicant: { id: string; status: string; tier: number | null; jurisdiction: number | null; kycExpiry: string | null; reviewedAt: string };
  wallets: { address: string; linkedAt: string }[];
};

export type OracleJob = { id: number; wallet: string; status: string; action: string | null; signature: string | null; lastError: string | null; updatedAt: string };

export class OracleClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  private async request<T>(method: string, path: string, body?: string, headers: Record<string, string> = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body,
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    if (!res.ok) throw new OracleError(res.status, json.error ?? 'oracle_error', json.message ?? `Oracle returned ${res.status}`);
    return json as T;
  }

  challenge(wallet: string, applicantId: string) {
    return this.request<{ nonce: string; message: string; expiresAt: string }>(
      'POST',
      `/wallets/${encodeURIComponent(wallet)}/challenge`,
      JSON.stringify({ applicantId }),
    );
  }

  link(wallet: string, nonce: string, signature: string) {
    return this.request<{ applicantId: string; wallet: string }>(
      'POST',
      `/wallets/${encodeURIComponent(wallet)}/link`,
      JSON.stringify({ nonce, signature }),
    );
  }

  async applicant(id: string): Promise<OracleApplicant | null> {
    try {
      return await this.request<OracleApplicant>('GET', `/applicants/${encodeURIComponent(id)}`);
    } catch (error) {
      if (error instanceof OracleError && error.status === 404) return null;
      throw error;
    }
  }

  jobs(wallet: string) {
    return this.request<OracleJob[]>('GET', `/jobs?wallet=${encodeURIComponent(wallet)}`);
  }

  /** Delivers a provider webhook (raw body + provider signature headers). */
  webhook(rawBody: string, headers: Record<string, string>) {
    return this.request<{ result: string }>('POST', '/webhooks/kyc', rawBody, headers);
  }
}
