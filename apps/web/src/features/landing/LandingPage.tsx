/* The home page, clean: the product's own screens in browser frames on a pale page with hairline
   rules. The hero says what the market is and shows the screen a buyer pays from (the exact
   amount, the account, the time left, the USDC they get). Then how a purchase works (three steps,
   each with the part of the screen it happens on), the payments app (what you can do, as the
   app's own picker), how each payment is protected, merchants, businesses and developers (a charge
   created through the API), and the questions people ask first. The market runs on Stellar. */
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { fmt, useDocumentMeta, useI18n } from '@/i18n';
import { Icon, type IconName } from '@/components/ui/Icon';
import { LogoGlyph } from '@/components/ui/Logo';
import { TokenMark } from '@/components/p2p/parts';
import { money, units } from '@/lib/format';

const EXAMPLE = {
  fiat: 380,
  price: 3.77,
  feeBps: 30,
  account: 'BCP · CCI 002 193 00123456789012',
  holder: 'Norte Cambios SAC',
};

const TOKENS =
  Math.floor((EXAMPLE.fiat / EXAMPLE.price) * (1 - EXAMPLE.feeBps / 10000) * 100) / 100;

/** A browser window holding one of the product's screens. */
function BrowserFrame({
  url,
  children,
  className = '',
}: {
  url: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`frame ${className}`} aria-hidden="true">
      <div className="frame-bar">
        <span className="frame-dots">
          <span />
          <span />
          <span />
        </span>
        <span className="frame-url">{url}</span>
        <span />
      </div>
      {children}
    </div>
  );
}

/** «S/ 380,00 → 100,49 USDC»: what is paid and what arrives. */
function Conversion({ size = 'lg' }: { size?: 'lg' | 'sm' }) {
  const { lang } = useI18n();
  const big = size === 'lg';
  return (
    <p
      className={`num flex flex-wrap items-center gap-x-3 gap-y-1 ${big ? 'text-[clamp(1.5rem,4.2vw,2.25rem)] tracking-[-0.03em]' : 'text-[0.9375rem]'}`}
    >
      <span>{money(lang, EXAMPLE.fiat, 'PEN')}</span>
      <Icon name="chevronRight" size={big ? 26 : 16} className="text-ink-3" />
      <span className="inline-flex items-center gap-2">
        <TokenMark symbol="USDC" size={big ? 32 : 18} />
        {units(lang, TOKENS, 'USDC')}
      </span>
    </p>
  );
}

/** The screen a buyer pays from, in a browser frame. */
function PayScreen() {
  const { t, lang } = useI18n();
  const s = t.landing.slip;
  const f = t.landing.frame;
  const rows: [string, string][] = [
    [s.holder, EXAMPLE.holder],
    [s.account, EXAMPLE.account],
    [f.price, fmt(f.priceValue, { price: money(lang, EXAMPLE.price, 'PEN') })],
    [s.left, '27:41'],
  ];
  return (
    <BrowserFrame url={f.url}>
      <div className="flex items-center gap-3 border-b border-line px-5 py-4 sm:px-8">
        <LogoGlyph size={24} className="text-ink" />
        <span className="h-5 w-px bg-line" />
        <span className="text-[0.9375rem] text-ink-2">{f.wallet}</span>
        <span className="flex-1" />
        <Icon name="close" size={18} className="text-ink-3" />
      </div>
      <div className="grid gap-8 px-5 py-7 sm:grid-cols-[10rem_minmax(0,1fr)] sm:px-8 md:grid-cols-[12rem_minmax(0,1fr)] md:py-9">
        <div className="step-rail hidden sm:flex">
          {f.steps.map((step, i) => (
            <span key={step} aria-current={i === 1 ? 'step' : undefined}>
              {step}
            </span>
          ))}
        </div>
        <div className="min-w-0 max-w-[34rem]">
          <h3 className="text-[1.5rem]">{s.transfer}</h3>
          <p className="mt-2 text-[0.875rem] text-ink-3">
            {fmt(f.context, { merchant: EXAMPLE.holder })}
          </p>
          <div className="mt-3">
            <Conversion />
          </div>
          <dl className="mt-6 flex flex-col gap-3 border-t border-line pt-5 text-[0.9375rem]">
            {rows.map(([k, v]) => (
              <div key={k} className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-3">
                <dt className="text-ink-3">{k}</dt>
                <dd className="num min-w-0 break-words">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-6 flex items-center gap-2 border-t border-line pt-5 text-[0.8125rem] text-ink-3">
            <Icon name="lock" size={15} className="shrink-0" />
            {s.locked}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-3 border-t border-line px-5 py-4 sm:px-8 sm:pl-[calc(10rem+4rem)] md:pl-[calc(12rem+4rem)]">
        <span className="btn btn-soft btn-sm">
          <Icon name="back" size={15} />
          {f.back}
        </span>
        <span className="btn btn-ink btn-sm">{s.button}</span>
      </div>
    </BrowserFrame>
  );
}

/** The part of the screen each step happens on. */
function StepFragment({ step }: { step: number }) {
  const { t, lang } = useI18n();
  const u = t.landing.how.ui;
  const s = t.landing.slip;
  const card =
    'w-full max-w-[17rem] rounded-[14px] border border-line bg-sheet p-4 shadow-[var(--shadow-sheet)]';
  if (step === 0)
    return (
      <div className={card}>
        <p className="text-[0.75rem] text-ink-3">{u.pay}</p>
        <div className="mock-field num mt-1.5">{money(lang, EXAMPLE.fiat, 'PEN')}</div>
        <p className="mt-3 text-[0.75rem] text-ink-3">{u.with}</p>
        <div className="mock-field mt-1.5 justify-between">
          {u.method}
          <Icon name="chevron" size={14} className="text-ink-3" />
        </div>
      </div>
    );
  if (step === 1)
    return (
      <div className={card}>
        <p className="text-[0.75rem] text-ink-3">{s.transfer}</p>
        <p className="figure mt-2 text-[1.5rem]">
          <span className="marker">{money(lang, EXAMPLE.fiat, 'PEN')}</span>
        </p>
        <p className="num mt-3 truncate text-[0.8125rem] text-ink-2">{EXAMPLE.account}</p>
      </div>
    );
  return (
    <div className={card}>
      <p className="text-[0.75rem] text-ink-3">{u.received}</p>
      <p className="num mt-2 flex items-center gap-2 text-[1.375rem] tracking-[-0.02em]">
        <TokenMark symbol="USDC" size={24} />
        {units(lang, TOKENS, 'USDC')}
      </p>
      <div className="mt-3 text-ink-2">
        <Conversion size="sm" />
      </div>
    </div>
  );
}

const TRUST_ICONS: IconName[] = ['lock', 'clock', 'users', 'list'];
const APP_ICONS: IconName[] = ['send', 'qr', 'bank', 'link'];

/** A section's heading block: a title and its lede. */
function Heading({ id, title, lede }: { id: string; title: string; lede?: string }) {
  return (
    <div className="max-w-[40rem]">
      <h2 id={id} className="text-[clamp(1.75rem,3.6vw,2.5rem)] leading-[1.1]">
        {title}
      </h2>
      {lede && <p className="mt-4 text-[1.0625rem] text-ink-2">{lede}</p>}
    </div>
  );
}

export default function LandingPage() {
  const { t } = useI18n();
  const l = t.landing;
  useDocumentMeta(l.metaTitle, l.metaDescription);
  return (
    <>
      <section className="mx-auto max-w-6xl px-6 pt-14 pb-16 sm:px-8 md:pt-20 md:pb-24">
        <div className="mx-auto flex max-w-[48rem] flex-col items-center text-center">
          <span className="eyebrow">
            <TokenMark symbol="USDC" size={22} />
            {l.eyebrow}
          </span>
          <h1 className="display mt-6 text-[clamp(2.3rem,6.4vw,4.25rem)]">{l.hero.title}</h1>
          <p className="mt-6 max-w-[40rem] text-[1.0625rem] text-ink-2 sm:text-[1.125rem]">
            {l.hero.body}
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link to="/app" className="btn btn-ink btn-lg">
              {l.hero.open}
            </Link>
            <Link to="/dashboard" className="btn btn-soft btn-lg">
              {l.hero.merchant}
            </Link>
          </div>
          <p className="mt-6 max-w-[38rem] text-[0.875rem] text-ink-3">{l.hero.rails}</p>
        </div>
        <div className="mt-14 md:mt-16">
          <PayScreen />
          <p className="mt-4 text-center text-[0.875rem] text-ink-3">{l.slip.caption}</p>
        </div>
      </section>

      <section aria-labelledby="how-h" className="rule-top">
        <div className="mx-auto max-w-6xl px-6 py-16 sm:px-8 md:py-24">
          <Heading id="how-h" title={l.how.title} lede={l.how.lede} />
          <ol className="mt-12 grid gap-5 md:grid-cols-3">
            {l.how.steps.map((step, i) => (
              <li key={step.title} className="sheet flex flex-col overflow-hidden">
                <div className="fragment" aria-hidden="true">
                  <StepFragment step={i} />
                </div>
                <div className="flex flex-col gap-2 p-6">
                  <span className="text-[0.8125rem] font-medium text-[var(--primary)]">
                    {fmt(l.how.stepLabel, { n: i + 1 })}
                  </span>
                  <h3 className="text-[1.1875rem]">{step.title}</h3>
                  <p className="text-[0.9375rem] text-ink-2">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
          <p className="mt-6 max-w-[44rem] text-[0.9375rem] text-ink-2">{l.how.sell}</p>
        </div>
      </section>

      <section aria-labelledby="app-h" className="rule-top">
        <div className="mx-auto grid max-w-6xl gap-12 px-6 py-16 sm:px-8 md:py-24 lg:grid-cols-[1fr_1.15fr] lg:items-center">
          <div className="flex flex-col items-start gap-6">
            <Heading id="app-h" title={l.app.title} lede={l.app.body} />
            <Link to="/app" className="btn btn-ink btn-lg">
              {l.app.cta}
            </Link>
          </div>
          <BrowserFrame url={l.app.pick.url}>
            <div className="px-5 py-7 sm:px-8">
              <h3 className="text-[1.375rem]">{l.app.pick.title}</h3>
              <ul className="mt-5 flex flex-col gap-2.5" role="list">
                {l.app.points.map((p, i) => (
                  <li
                    key={p.title}
                    className="flex items-center gap-3.5 rounded-[12px] border border-line bg-sheet px-4 py-3.5"
                  >
                    <span className="grid size-9 shrink-0 place-items-center rounded-full bg-well text-ink-2">
                      <Icon name={APP_ICONS[i] ?? 'send'} size={17} />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <b className="text-[0.9375rem] font-medium">{p.title}</b>
                      <span className="text-[0.8125rem] text-ink-3">{p.body}</span>
                    </span>
                    <Icon name="chevronRight" size={16} className="shrink-0 text-ink-3" />
                  </li>
                ))}
              </ul>
            </div>
          </BrowserFrame>
        </div>
      </section>

      <section aria-labelledby="trust-h" className="rule-top">
        <div className="mx-auto max-w-6xl px-6 py-16 sm:px-8 md:py-24">
          <Heading id="trust-h" title={l.trust.title} />
          <ul
            className="mt-12 grid gap-px overflow-hidden rounded-[16px] border border-line bg-line sm:grid-cols-2"
            role="list"
          >
            {l.trust.items.map((it, i) => (
              <li key={it.title} className="flex flex-col gap-3 bg-sheet p-6 md:p-8">
                <span
                  className="grid size-10 place-items-center rounded-full bg-well text-ink-2"
                  aria-hidden="true"
                >
                  <Icon name={TRUST_ICONS[i] ?? 'lock'} size={19} />
                </span>
                <h3 className="text-[1.125rem]">{it.title}</h3>
                <p className="text-[0.9375rem] text-ink-2">{it.body}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section id="merchants" aria-labelledby="merchants-h" className="rule-top scroll-mt-20">
        <div className="mx-auto grid max-w-6xl gap-12 px-6 py-16 sm:px-8 md:py-24 lg:grid-cols-[1fr_1.1fr] lg:items-start">
          <div className="flex flex-col items-start gap-6">
            <Heading id="merchants-h" title={l.merchants.title} lede={l.merchants.body} />
            <Link to="/dashboard" className="btn btn-ink btn-lg">
              {l.merchants.cta}
            </Link>
          </div>
          <ul className="sheet flex flex-col px-6" role="list">
            {l.merchants.points.map((p) => (
              <li key={p} className="flex gap-3 border-b border-line py-4 last:border-0">
                <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-primary text-on-primary">
                  <Icon name="check" size={12} strokeWidth={3} />
                </span>
                <span className="text-ink-2">{p}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section id="business" aria-labelledby="business-h" className="rule-top scroll-mt-20">
        <div className="mx-auto grid max-w-6xl gap-12 px-6 py-16 sm:px-8 md:py-24 lg:grid-cols-[1fr_1.15fr]">
          <div className="flex flex-col items-start gap-6">
            <Heading id="business-h" title={l.business.title} lede={l.business.body} />
            <dl className="flex w-full flex-col">
              {l.business.points.map((p) => (
                <div key={p.title} className="border-t border-line py-4">
                  <dt className="font-medium">{p.title}</dt>
                  <dd className="mt-1 text-[0.9375rem] text-ink-2">{p.body}</dd>
                </div>
              ))}
            </dl>
            <Link to="/docs" className="btn btn-soft btn-lg">
              {l.business.cta}
            </Link>
          </div>
          <figure className="frame min-w-0 self-start">
            <figcaption className="flex items-center gap-2 border-b border-line bg-[var(--frame-bar)] px-4 py-2.5 text-[0.8125rem]">
              <span className="rounded-[6px] bg-ok-soft px-1.5 py-0.5 font-mono text-[0.75rem] font-semibold text-ok">
                POST
              </span>
              <code className="truncate text-ink-2">/v1/p2p/charges</code>
              <span className="flex-1" />
              <span className="hidden text-ink-3 sm:inline">{l.business.codeLabel}</span>
            </figcaption>
            <pre className="code-panel overflow-x-auto px-5 py-4 text-[0.8125rem] leading-relaxed">
              <code>{`curl "$PIER_API_URL/v1/p2p/charges" \\
  -H "Authorization: Bearer $PIER_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "currency": "PEN",
    "fiatAmount": "120.00",
    "network": "testnet",
    "token": "USDC",
    "recipient": "acc_...",
    "description": "Pedido #1042"
  }'`}</code>
            </pre>
            <p className="border-t border-line bg-[var(--frame-bar)] px-4 py-2.5 text-[0.75rem] font-medium text-ink-3">
              {l.business.response}
            </p>
            <pre className="code-panel overflow-x-auto px-5 py-4 text-[0.8125rem] leading-relaxed">
              <code>{`{ "id": "ch_...", "url": ".../c/ch_...",
  "status": "open", ... }`}</code>
            </pre>
          </figure>
        </div>
      </section>

      <section aria-labelledby="faq-h" className="rule-top">
        <div className="mx-auto grid max-w-6xl gap-10 px-6 py-16 sm:px-8 md:py-24 lg:grid-cols-[1fr_1.6fr]">
          <Heading id="faq-h" title={l.faq.title} />
          <div className="flex flex-col border-t border-line">
            {l.faq.items.map((f) => (
              <details key={f.q} className="group border-b border-line py-5">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-[1.0625rem] font-medium">
                  {f.q}
                  <Icon
                    name="chevron"
                    className="shrink-0 text-ink-3 transition-transform group-open:rotate-180"
                  />
                </summary>
                <p className="mt-3 text-ink-2">{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="rule-top">
        <div className="mx-auto max-w-6xl px-6 py-16 sm:px-8 md:py-24">
          <div className="flex flex-col items-center gap-6 rounded-[20px] border border-line bg-sheet bg-[radial-gradient(70%_120%_at_50%_0%,rgb(94_216_255/0.16),transparent_70%)] px-6 py-14 text-center shadow-[var(--shadow-sheet)]">
            <LogoGlyph size={40} className="text-ink" />
            <h2 className="text-[clamp(1.75rem,3.6vw,2.5rem)] leading-[1.1]">{l.closing.title}</h2>
            <p className="max-w-[34rem] text-ink-2">{l.closing.body}</p>
            <div className="flex flex-wrap justify-center gap-3">
              <Link to="/app" className="btn btn-ink btn-lg">
                {l.hero.open}
              </Link>
              <Link to="/docs" className="btn btn-soft btn-lg">
                {l.business.cta}
              </Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
