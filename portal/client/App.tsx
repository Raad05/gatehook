import { jurisdictionCode, Tier } from '@gatehook/sdk';
import { type Address, address, getBase58Decoder, isAddress } from '@solana/kit';
import type { UiWalletAccount } from '@wallet-standard/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type PortalConfig, session, type Status } from './api.ts';
import { describeError } from './errors.ts';
import {
  explorerTx,
  formatAmount,
  type Holder,
  loadHolder,
  loadToken,
  makeRpc,
  parseAmount,
  preflight,
  type TokenInfo,
  transfer,
} from './chain.ts';
import { type ActiveWallet, ConnectButton, ExtensionWalletBridge, loadBurner, useCompatibleWallets } from './wallet.tsx';

const COUNTRIES = ['US', 'DE', 'GB', 'SG', 'FR', 'JP'];
const TIERS = [
  ['accredited', 'Accredited investor (Reg D)'],
  ['non_us', 'Non-US person (Reg S)'],
  ['qualified_purchaser', 'Qualified purchaser'],
] as const;

function usePoll(fn: () => Promise<void>, ms: number, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const tick = () => alive && fn().catch(() => {});
    tick();
    const id = setInterval(tick, ms);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [fn, ms, enabled]);
}

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run };
}

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

export function App() {
  const [config, setConfig] = useState<PortalConfig | null>(null);
  const [token, setToken] = useState<TokenInfo | null>(null);
  const [signedIn, setSignedIn] = useState(!!session.get());
  const [status, setStatus] = useState<Status | null>(null);
  const [wallet, setWallet] = useState<ActiveWallet | null>(null);
  const [account, setAccount] = useState<{ account: UiWalletAccount; name: string } | null>(null);
  const [holder, setHolder] = useState<Holder | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const rpc = useMemo(() => (config ? makeRpc(config.rpcUrl) : null), [config]);

  useEffect(() => {
    api
      .config()
      .then(async (c) => {
        setConfig(c);
        setToken(await loadToken(makeRpc(c.rpcUrl), c.mint));
      })
      .catch((e: unknown) => setLoadError(describeError(e)));
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.status());
    } catch (e) {
      if (e instanceof Error && /Sign in/.test(e.message)) {
        session.clear();
        setSignedIn(false);
      }
      throw e;
    }
  }, []);
  usePoll(refreshStatus, 3_000, signedIn);

  const refreshHolder = useCallback(async () => {
    if (rpc && token && wallet) setHolder(await loadHolder(rpc, token, wallet.address));
  }, [rpc, token, wallet]);
  usePoll(refreshHolder, 4_000, !!wallet && !!token);

  if (loadError) return <Shell><div className="card error">Could not load portal: {loadError}</div></Shell>;
  if (!config || !token) return <Shell><div className="card">Loading…</div></Shell>;

  const linked = !!wallet && !!status?.wallets.some((w) => w.address === wallet.address);
  const approved = status?.applicant?.status === 'approved';

  return (
    <Shell subtitle={`${token.name} · ${config.cluster}`}>
      <Steps steps={[signedIn, approved, linked && !!holder?.identity, (holder?.balance ?? 0n) > 0n]} />
      {!signedIn ? (
        <SignIn onDone={() => setSignedIn(true)} />
      ) : (
        <>
          <KycCard config={config} status={status} onChange={refreshStatus} onSignOut={() => { session.clear(); setSignedIn(false); setStatus(null); }} />
          <WalletCard
            config={config}
            wallet={wallet}
            holder={holder}
            token={token}
            status={status}
            linked={linked}
            onBurner={async () => setWallet(await loadBurner())}
            onAccount={(a, name) => setAccount({ account: a, name })}
            onDisconnect={() => { setWallet(null); setAccount(null); setHolder(null); }}
            onLinked={refreshStatus}
            onFunded={refreshHolder}
          />
          {account && !wallet && (
            <ExtensionWalletBridge account={account.account} cluster={config.cluster} name={account.name} onReady={setWallet} />
          )}
          {wallet && holder && rpc && (
            <TransferCard config={config} rpc={rpc} token={token} wallet={wallet} holder={holder} onSent={refreshHolder} />
          )}
        </>
      )}
    </Shell>
  );
}

function Shell({ children, subtitle }: { children: React.ReactNode; subtitle?: string }) {
  return (
    <main>
      <header>
        <h1>Gatehook Investor Portal</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </header>
      {children}
      <footer className="muted">Demo portal. KYC, sign-in and faucet are simulated; compliance checks run on-chain.</footer>
    </main>
  );
}

function Steps({ steps }: { steps: boolean[] }) {
  const labels = ['Sign in', 'Verify identity', 'Link wallet', 'Hold & transfer'];
  return (
    <ol className="steps">
      {labels.map((label, i) => (
        <li key={label} className={steps[i] ? 'done' : ''}>{label}</li>
      ))}
    </ol>
  );
}

function SignIn({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const { busy, error, run } = useAction();
  return (
    <section className="card">
      <h2>1. Sign in</h2>
      <p className="muted">Demo sign-in: any email creates or resumes an investor profile.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            session.set((await api.signIn(email)).token);
            onDone();
          });
        }}
      >
        <input type="email" required placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button disabled={busy}>{busy ? 'Signing in…' : 'Continue'}</button>
      </form>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function KycCard({ config, status, onChange, onSignOut }: { config: PortalConfig; status: Status | null; onChange: () => Promise<void>; onSignOut: () => void }) {
  const [tier, setTier] = useState<string>('accredited');
  const [country, setCountry] = useState('US');
  const { busy, error, run } = useAction();
  const applicant = status?.applicant;
  const submit = (body: Parameters<typeof api.kyc>[0]) => run(async () => { await api.kyc(body); await onChange(); });

  return (
    <section className="card">
      <div className="row">
        <h2>2. Verify identity</h2>
        <button className="link" onClick={onSignOut}>Sign out {status?.email}</button>
      </div>
      {applicant ? (
        <p>
          KYC status: <Badge value={applicant.status} />
          {applicant.status === 'approved' && applicant.tier !== null && (
            <> · {Tier[applicant.tier]} · {jurisdictionCode(applicant.jurisdiction ?? 0)} · valid until {new Date(applicant.kycExpiry!).toLocaleDateString()}</>
          )}
        </p>
      ) : (
        <p className="muted">Not verified yet.</p>
      )}
      {config.demoKyc ? (
        <div className="demo">
          <span className="tag">demo KYC provider</span>
          <select value={tier} onChange={(e) => setTier(e.target.value)}>
            {TIERS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
          <select value={country} onChange={(e) => setCountry(e.target.value)}>
            {COUNTRIES.map((c) => <option key={c}>{c}</option>)}
          </select>
          <button disabled={busy} onClick={() => submit({ status: 'approved', tier, country })}>
            {applicant?.status === 'approved' ? 'Update KYC' : 'Complete KYC'}
          </button>
          {applicant?.status === 'approved' && (
            <button className="danger" disabled={busy} onClick={() => submit({ status: 'revoked' })}>Revoke KYC</button>
          )}
        </div>
      ) : (
        <p className="muted">Complete verification with the issuer's KYC provider.</p>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function WalletCard(props: {
  config: PortalConfig;
  wallet: ActiveWallet | null;
  holder: Holder | null;
  token: TokenInfo;
  status: Status | null;
  linked: boolean;
  onBurner: () => Promise<void>;
  onAccount: (a: UiWalletAccount, name: string) => void;
  onDisconnect: () => void;
  onLinked: () => Promise<void>;
  onFunded: () => Promise<void>;
}) {
  const { config, wallet, holder, token, status, linked } = props;
  const wallets = useCompatibleWallets(config.cluster);
  const { busy, error, run } = useAction();
  const [faucetTx, setFaucetTx] = useState<string | null>(null);
  const job = status?.wallets.find((w) => w.address === wallet?.address)?.job;
  const identity = holder?.identity;
  const nowSec = BigInt(Math.floor(Date.now() / 1000));

  const link = () =>
    run(async () => {
      if (!wallet) return;
      const { nonce, message } = await api.challenge(wallet.address);
      const signature = await wallet.signMessage(new TextEncoder().encode(message));
      await api.link(wallet.address, nonce, getBase58Decoder().decode(signature));
      await props.onLinked();
    });

  return (
    <section className="card">
      <h2>3. Link your wallet</h2>
      {!wallet ? (
        <div className="wallets">
          {wallets.map((w) => <ConnectButton key={w.name} wallet={w} onAccount={(a) => props.onAccount(a, w.name)} />)}
          {wallets.length === 0 && <p className="muted">No compatible wallet extension found for {config.cluster}.</p>}
          <button className="secondary" onClick={() => void run(props.onBurner)}>Use a burner wallet (test only)</button>
        </div>
      ) : (
        <>
          <div className="row">
            <p>
              <strong>{wallet.label}</strong> <code>{wallet.address}</code>
              {holder && <span className="muted"> · {formatAmount(holder.sol, 9)} SOL</span>}
            </p>
            <button className="link" onClick={props.onDisconnect}>Disconnect</button>
          </div>
          {!linked ? (
            <button disabled={busy || status?.applicant === null} onClick={() => void link()}>
              {busy ? 'Waiting for signature…' : 'Sign message to link wallet'}
            </button>
          ) : (
            <p>
              Linked to your profile.{' '}
              {job && <>Oracle job: <Badge value={job.status} />{job.action && job.action !== 'noop' ? ` (${job.action})` : ''}</>}
            </p>
          )}
          <div className="identity">
            <strong>On-chain identity:</strong>{' '}
            {identity ? (
              <>
                {Tier[identity.tier]} · {jurisdictionCode(identity.jurisdiction)} ·{' '}
                {identity.kycExpiry > nowSec
                  ? <Badge value="valid" />
                  : <Badge value="expired" />}
                {identity.frozen && <> <Badge value="frozen" /></>}
              </>
            ) : (
              <span className="muted">none yet — transfers to and from this wallet will be rejected</span>
            )}
          </div>
          {config.demoFaucet && linked && identity && (
            <div className="demo">
              <span className="tag">demo faucet</span>
              <button
                className="secondary"
                disabled={busy}
                onClick={() => void run(async () => { setFaucetTx((await api.faucet(wallet.address)).signature); await props.onFunded(); })}
              >
                Get 0.01 SOL + 100 {token.name.split(' (')[0]}
              </button>
              {faucetTx && <a href={explorerTx(faucetTx, config.cluster, config.rpcUrl)} target="_blank" rel="noreferrer">view tx</a>}
            </div>
          )}
        </>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function TransferCard({ config, rpc, token, wallet, holder, onSent }: {
  config: PortalConfig;
  rpc: ReturnType<typeof makeRpc>;
  token: TokenInfo;
  wallet: ActiveWallet;
  holder: Holder;
  onSent: () => Promise<void>;
}) {
  const [to, setTo] = useState('');
  const [amountText, setAmountText] = useState('');
  const [verdict, setVerdict] = useState<{ ok: boolean; message: string } | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const amount = parseAmount(amountText, token.decimals);
  const validTo = isAddress(to.trim());

  // Live preflight: the same checks the hook will run, before the user signs.
  useEffect(() => {
    setVerdict(null);
    if (!validTo || !amount) return;
    const id = setTimeout(() => {
      preflight(rpc, token, wallet.address, address(to.trim()) as Address, amount)
        .then((r) => setVerdict(r.ok ? { ok: true, message: 'Transfer allowed by compliance rules' } : { ok: false, message: r.message }))
        .catch((e: unknown) => setVerdict({ ok: false, message: describeError(e) }));
    }, 400);
    return () => clearTimeout(id);
  }, [to, amountText, wallet.address]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="card">
      <h2>4. Hold &amp; transfer</h2>
      <p className="balance">{formatAmount(holder.balance, token.decimals)} <span className="muted">{token.name}</span></p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!amount || !validTo) return;
          void run(async () => {
            setSent(await transfer(rpc, token, wallet, address(to.trim()), amount));
            setAmountText('');
            await onSent();
          });
        }}
      >
        <input placeholder="Recipient wallet address" value={to} onChange={(e) => setTo(e.target.value)} />
        <input placeholder="Amount" inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} className="amount" />
        <button disabled={busy || !verdict?.ok}>{busy ? 'Sending…' : 'Send'}</button>
      </form>
      {to && !validTo && <p className="error">Not a valid address</p>}
      {verdict && <p className={verdict.ok ? 'ok' : 'error'}>{verdict.ok ? '✓ ' : '✗ '}{verdict.message}</p>}
      {sent && (
        <p className="ok">
          Sent {short(sent)} — <a href={explorerTx(sent, config.cluster, config.rpcUrl)} target="_blank" rel="noreferrer">view on explorer</a>
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function Badge({ value }: { value: string }) {
  const tone = ['approved', 'confirmed', 'valid'].includes(value) ? 'ok' : ['pending', 'processing'].includes(value) ? 'wait' : 'bad';
  return <span className={`badge ${tone}`}>{value}</span>;
}
