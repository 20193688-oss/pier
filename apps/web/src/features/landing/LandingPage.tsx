/* The home page. The hero's second half is the thing the product is about: an order slip with
   the exact amount to transfer marked like a receipt someone highlighted, the account to pay, and
   the clock. Then how a purchase works (a real sequence, so numbered), the payments app (/app),
   why nobody keeps the funds, merchants, businesses and the API, and the questions people ask
   first. The market runs on Stellar. */
import { Link } from 'react-router';
import { useDocumentMeta, useI18n } from '@/i18n';
import { Icon, type IconName } from '@/components/ui/Icon';
import { money, units } from '@/lib/format';

const EXAMPLE = {
  fiat: 150000,
  price: 1488.5,
  feeBps: 30,
  cbu: '0170 0992 2200 0001 2345 61',
  holder: 'Norte Cambios SRL',
};

function OrderSlip() {
  const { t, lang } = useI18n();
  const s = t.landing.slip;
  const tokens =
    Math.floor((EXAMPLE.fiat / EXAMPLE.price) * (1 - EXAMPLE.feeBps / 10000) * 100) / 100;
  return (
    <figure className="relative mx-auto w-full max-w-[25rem]">
      <div
        className="slip shadow-[0_30px_60px_-30px_rgb(16_38_31/0.45)] sm:rotate-[-1.2deg]"
        aria-hidden="true"
      >
        <div className="flex items-center justify-between px-6 pt-5">
          <span className="text-[0.875rem] font-semibold text-ink-3">{s.order}</span>
          <span className="num inline-flex items-center gap-1.5 rounded-full bg-well px-2.5 py-1 text-[0.8125rem] font-semibold">
            <Icon name="clock" size={14} />
            27:41
          </span>
        </div>
        <div className="px-6 pt-4 pb-5">
          <p className="text-[0.9375rem] text-ink-2">{s.transfer}</p>
          <p className="figure mt-2 text-[clamp(1.55rem,7.4vw,2.2rem)]">
            <span className="marker marker-sweep">{money(lang, EXAMPLE.fiat, 'ARS')}</span>
          </p>
        </div>
        <div className="tear" />
        <dl className="flex flex-col gap-3 px-6 pt-3 pb-5 text-[0.9375rem]">
          <p className="text-[0.8125rem] font-semibold text-ink-3">{s.to}</p>
          <div className="flex justify-between gap-4">
            <dt className="text-ink-3">{s.holder}</dt>
            <dd className="text-right font-medium">{EXAMPLE.holder}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-ink-3">{s.cbu}</dt>
            <dd className="num text-right font-medium">{EXAMPLE.cbu}</dd>
          </div>
          <div className="flex justify-between gap-4 border-t border-dashed border-line-2 pt-3">
            <dt className="text-ink-3">{s.receive}</dt>
            <dd className="num text-right font-semibold">{units(lang, tokens, 'USDC')}</dd>
          </div>
        </dl>
        <div className="px-6 pb-6">
          <span className="btn btn-ink w-full">{s.button}</span>
          <p className="mt-3 flex items-center gap-2 text-[0.8125rem] text-ink-3">
            <Icon name="lock" size={15} />
            {s.locked}
          </p>
        </div>
      </div>
      <figcaption className="mt-5 text-center text-[0.875rem] text-ink-3">{s.caption}</figcaption>
    </figure>
  );
}

const TRUST_ICONS: IconName[] = ['lock', 'clock', 'users', 'list'];
const APP_ICONS: IconName[] = ['send', 'qr', 'bank', 'link'];

export default function LandingPage() {
  const { t } = useI18n();
  const l = t.landing;
  useDocumentMeta(l.metaTitle, l.metaDescription);
  return (
    <>
      <section className="mx-auto grid max-w-6xl items-center gap-12 px-4 pt-10 pb-16 md:pt-16 lg:grid-cols-[1.1fr_1fr] lg:gap-16 lg:pt-24">
        <div className="flex flex-col gap-6">
          <h1
            className="text-[2.2rem] leading-[1.04] sm:text-[3rem] lg:text-[3.5rem]"
            style={{ fontStretch: '118%', fontWeight: 780 }}
          >
            {l.hero.title}
          </h1>
          <p className="max-w-[34rem] text-[1.125rem] text-ink-2">{l.hero.body}</p>
          <div className="flex flex-wrap gap-3">
            <Link to="/app" className="btn btn-ink btn-lg">
              {l.hero.open}
            </Link>
            <Link to="/dashboard" className="btn btn-line btn-lg">
              {l.hero.merchant}
            </Link>
          </div>
          <p className="max-w-[34rem] text-[0.9375rem] text-ink-3">{l.hero.rails}</p>
        </div>
        <OrderSlip />
      </section>

      <section aria-labelledby="how-h" className="border-y border-line bg-sheet">
        <div className="mx-auto max-w-6xl px-4 py-16 md:py-20">
          <h2 id="how-h" className="text-[1.9rem] sm:text-[2.3rem]">
            {l.how.title}
          </h2>
          <p className="mt-3 max-w-[40rem] text-[1.0625rem] text-ink-2">{l.how.lede}</p>
          <ol className="mt-10 grid gap-8 md:grid-cols-3 md:gap-6">
            {l.how.steps.map((step, i) => (
              <li key={step.title} className="relative flex flex-col gap-3">
                <span
                  className="figure grid size-11 place-items-center rounded-full bg-ink text-[1.1rem] text-on-ink"
                  aria-hidden="true"
                >
                  {i + 1}
                </span>
                <h3 className="text-[1.2rem]">{step.title}</h3>
                <p className="text-ink-2">{step.body}</p>
              </li>
            ))}
          </ol>
          <p className="mt-10 max-w-[44rem] rounded-[16px] bg-well px-5 py-4 text-ink-2">
            {l.how.sell}
          </p>
        </div>
      </section>

      <section aria-labelledby="app-h" className="mx-auto max-w-6xl px-4 pt-16 md:pt-24">
        <div className="grid gap-10 lg:grid-cols-[1fr_1.2fr] lg:items-start">
          <div className="flex flex-col gap-5">
            <h2 id="app-h" className="text-[1.9rem] sm:text-[2.3rem]">
              {l.app.title}
            </h2>
            <p className="max-w-[34rem] text-[1.0625rem] text-ink-2">{l.app.body}</p>
            <div>
              <Link to="/app" className="btn btn-ink btn-lg">
                {l.app.cta}
              </Link>
            </div>
          </div>
          <ul className="grid gap-4 sm:grid-cols-2" role="list">
            {l.app.points.map((p, i) => (
              <li key={p.title} className="sheet flex gap-3 p-4">
                <span
                  className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-well text-ink"
                  aria-hidden="true"
                >
                  <Icon name={APP_ICONS[i] ?? 'send'} />
                </span>
                <div>
                  <h3 className="text-[1.0625rem]">{p.title}</h3>
                  <p className="mt-1 text-[0.9375rem] text-ink-2">{p.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section aria-labelledby="trust-h" className="mx-auto max-w-6xl px-4 py-16 md:py-24">
        <h2 id="trust-h" className="max-w-[30rem] text-[1.9rem] sm:text-[2.3rem]">
          {l.trust.title}
        </h2>
        <ul className="mt-10 grid gap-x-10 gap-y-9 sm:grid-cols-2" role="list">
          {l.trust.items.map((it, i) => (
            <li key={it.title} className="flex gap-4">
              <span
                className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-well text-ink"
                aria-hidden="true"
              >
                <Icon name={TRUST_ICONS[i] ?? 'lock'} />
              </span>
              <div>
                <h3 className="text-[1.125rem]">{it.title}</h3>
                <p className="mt-1.5 text-ink-2">{it.body}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section
        id="merchants"
        aria-labelledby="merchants-h"
        className="scroll-mt-20 bg-ink text-on-ink"
      >
        <div className="mx-auto grid max-w-6xl gap-10 px-4 py-16 md:grid-cols-2 md:py-20">
          <div className="flex flex-col gap-5">
            <h2 id="merchants-h" className="text-[1.9rem] sm:text-[2.3rem]">
              {l.merchants.title}
            </h2>
            <p className="text-[1.0625rem] opacity-85">{l.merchants.body}</p>
            <div>
              <Link
                to="/dashboard"
                className="btn btn-lg bg-marker text-marker-ink hover:brightness-95"
              >
                {l.merchants.cta}
              </Link>
            </div>
          </div>
          <ul className="flex flex-col gap-4" role="list">
            {l.merchants.points.map((p) => (
              <li
                key={p}
                className="flex gap-3 border-b border-[color-mix(in_oklab,var(--on-ink)_18%,transparent)] pb-4 last:border-0"
              >
                <Icon name="check" className="mt-0.5 shrink-0 text-marker" />
                <span className="opacity-90">{p}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section
        id="business"
        aria-labelledby="business-h"
        className="mx-auto max-w-6xl scroll-mt-20 px-4 py-16 md:py-24"
      >
        <div className="grid gap-12 lg:grid-cols-[1fr_1.1fr]">
          <div className="flex flex-col gap-5">
            <h2 id="business-h" className="text-[1.9rem] sm:text-[2.3rem]">
              {l.business.title}
            </h2>
            <p className="text-[1.0625rem] text-ink-2">{l.business.body}</p>
            <dl className="mt-2 flex flex-col gap-5">
              {l.business.points.map((p) => (
                <div key={p.title}>
                  <dt className="text-[1.0625rem] font-bold" style={{ fontStretch: '112%' }}>
                    {p.title}
                  </dt>
                  <dd className="mt-1 text-ink-2">{p.body}</dd>
                </div>
              ))}
            </dl>
            <div>
              <Link to="/docs" className="btn btn-line btn-lg">
                {l.business.cta}
              </Link>
            </div>
          </div>
          <figure className="min-w-0 self-start rounded-[22px] bg-ink p-5 text-on-ink sm:p-6">
            <figcaption className="mb-3 text-[0.875rem] font-semibold opacity-75">
              {l.business.codeLabel}
            </figcaption>
            <pre className="overflow-x-auto text-[0.8125rem] leading-relaxed">
              <code>{`curl "$PEDOSPE_API_URL/v1/p2p/charges" \\
  -H "Authorization: Bearer $PEDOSPE_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "currency": "ARS",
    "fiatAmount": "25000.00",
    "network": "testnet",
    "token": "USDC",
    "recipient": "acc_...",
    "description": "Pedido #1042"
  }'

# => { "id": "ch_...", "url": ".../c/ch_...",
#      "status": "open", ... }`}</code>
            </pre>
          </figure>
        </div>
      </section>

      <section aria-labelledby="faq-h" className="border-t border-line">
        <div className="mx-auto max-w-3xl px-4 py-16 md:py-20">
          <h2 id="faq-h" className="text-[1.9rem] sm:text-[2.3rem]">
            {l.faq.title}
          </h2>
          <div className="mt-8 flex flex-col">
            {l.faq.items.map((f) => (
              <details key={f.q} className="group border-b border-line py-4">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-[1.0625rem] font-semibold">
                  {f.q}
                  <Icon
                    name="chevron"
                    className="shrink-0 transition-transform group-open:rotate-180"
                  />
                </summary>
                <p className="mt-3 text-ink-2">{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4">
        <div className="flex flex-col items-start gap-5 rounded-[28px] bg-well px-6 py-10 sm:px-10 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-[1.6rem] sm:text-[2rem]">{l.closing.title}</h2>
            <p className="mt-2 text-ink-2">{l.closing.body}</p>
          </div>
          <Link to="/app" className="btn btn-ink btn-lg">
            {l.hero.open}
          </Link>
        </div>
      </section>
    </>
  );
}
