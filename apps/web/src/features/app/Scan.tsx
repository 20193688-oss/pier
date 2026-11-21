/* Scan: the camera (getUserMedia) read by the browser's BarcodeDetector, or by jsQR (Apache-2.0,
   loaded only when the browser has no detector); the flashlight where the camera has one. Or paste
   a QR: the "Paste QR" button reads the clipboard (an image is decoded, text is read as is), and
   Ctrl+V / the system's paste anywhere on the screen does the same; or type the code, or pick an
   image. What is read goes through @midpoint/payment-qr (routeScan) and
   opens the right screen. A secret key is never kept: the screen warns and forgets it. */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { fmt, useI18n } from '@/i18n';
import { Icon } from '@/components/ui/Icon';
import { Notice, Spinner, TextArea } from '@/components/ui/controls';
import { routeScan, sendPath, type ScanRoute } from '@/lib/app/scan-route';
import { useAppData } from '@/features/app/data';
import { Screen } from '@/features/app/shell';

interface DetectedCode {
  rawValue: string;
}
interface Detector {
  detect(source: CanvasImageSource): Promise<DetectedCode[]>;
}
type DetectorCtor = new (o: { formats: string[] }) => Detector;

const QR_KEY = 'midpoint.app.qr';

/** Keep a merchant QR for the pay screen (this tab only). */
export function keepQr(payload: string) {
  try {
    sessionStorage.setItem(QR_KEY, payload);
  } catch {
    /* passed in the navigation state too */
  }
}
export function keptQr(): string | null {
  try {
    return sessionStorage.getItem(QR_KEY);
  } catch {
    return null;
  }
}

async function makeDecoder(): Promise<
  (src: HTMLVideoElement | HTMLImageElement | ImageBitmap) => Promise<string | null>
> {
  const Ctor = (globalThis as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
  if (Ctor) {
    try {
      const d = new Ctor({ formats: ['qr_code'] });
      return async (src) => (await d.detect(src))[0]?.rawValue ?? null;
    } catch {
      /* fall through to jsQR */
    }
  }
  const { default: jsQR } = await import('jsqr');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return async (src) => {
    const w = 'videoWidth' in src ? src.videoWidth : src.width;
    const h = 'videoHeight' in src ? src.videoHeight : src.height;
    if (!ctx || !w || !h) return null;
    // Large photos are scaled down: a QR stays readable and decoding stays quick.
    const scale = Math.min(1, 960 / Math.max(w, h));
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return jsQR(img.data, img.width, img.height)?.data ?? null;
  };
}

export default function Scan() {
  const { t } = useI18n();
  const s = t.app.scan;
  const navigate = useNavigate();
  const { network, token } = useAppData();
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [camera, setCamera] = useState<'starting' | 'on' | 'denied' | 'none'>('starting');
  const [torch, setTorch] = useState<boolean | null>(null);
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [secret, setSecret] = useState(false);
  const handled = useRef(false);

  const go = useCallback(
    (raw: string) => {
      if (!token || !network) return;
      const r: ScanRoute = routeScan(raw, {
        origins: [location.origin],
        token,
        networkPassphrase: network.networkPassphrase,
      });
      setText('');
      if (r.to === 'send') return navigate(sendPath(r));
      if (r.to === 'charge') return navigate(`/app/charge/${encodeURIComponent(r.chargeId)}`);
      if (r.to === 'pay-qr') {
        keepQr(r.payload);
        return navigate('/app/pay-qr', { state: { qr: r.payload } });
      }
      handled.current = false;
      if (r.to === 'secret') return setSecret(true);
      const msg =
        r.problem === 'other-asset'
          ? fmt(s.otherAsset, { asset: r.asset ?? '' })
          : r.problem === 'other-network'
            ? s.otherNetwork
            : r.problem === 'memo'
              ? s.memo
              : r.problem === 'qr-not-taken'
                ? s.qrNotTaken
                : s.unsupported[r.problem];
      setProblem(msg);
    },
    [navigate, network, token, s],
  );

  // The camera: started once, stopped when the screen goes.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (!navigator.mediaDevices?.getUserMedia) {
      setCamera('none');
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      .then(async (ms) => {
        if (!alive) return ms.getTracks().forEach((tr) => tr.stop());
        stream.current = ms;
        const v = video.current!;
        v.srcObject = ms;
        await v.play().catch(() => {});
        setCamera('on');
        const track = ms.getVideoTracks()[0];
        const caps = (track?.getCapabilities?.() ?? {}) as { torch?: boolean };
        if (caps.torch) setTorch(false);
        const decode = await makeDecoder();
        const tick = async () => {
          if (!alive) return;
          if (!handled.current && v.readyState >= 2) {
            const found = await decode(v).catch(() => null);
            if (found && alive && !handled.current) {
              handled.current = true;
              go(found);
            }
          }
          timer = setTimeout(tick, 220);
        };
        void tick();
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setCamera((e as Error)?.name === 'NotAllowedError' ? 'denied' : 'none');
      });
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      stream.current?.getTracks().forEach((tr) => tr.stop());
      stream.current = null;
    };
  }, [go]);

  const toggleTorch = async () => {
    const track = stream.current?.getVideoTracks()[0];
    if (!track || torch === null) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torch } as MediaTrackConstraintSet] });
      setTorch(!torch);
    } catch {
      setTorch(null);
    }
  };

  const fromImage = async (file: Blob | undefined | null) => {
    if (!file) return;
    setProblem(null);
    try {
      const bitmap = await createImageBitmap(file);
      const decode = await makeDecoder();
      const found = await decode(bitmap);
      if (found) go(found);
      else setProblem(s.noCodeInImage);
    } catch {
      setProblem(s.noCodeInImage);
    }
  };

  /** The clipboard's first image (decoded), else its text; nothing usable says so. */
  const pasteQr = async () => {
    setProblem(null);
    const clip = navigator.clipboard;
    try {
      if (clip?.read) {
        for (const item of await clip.read()) {
          const image = item.types.find((ty) => ty.startsWith('image/'));
          if (image) return void (await fromImage(await item.getType(image)));
          if (item.types.includes('text/plain')) {
            const value = (await (await item.getType('text/plain')).text()).trim();
            if (value) return go(value);
          }
        }
      } else if (clip?.readText) {
        const value = (await clip.readText()).trim();
        if (value) return go(value);
      }
    } catch {
      /* no permission or nothing readable: said below */
    }
    setProblem(s.pasteEmpty);
  };

  // Ctrl+V (or the system's paste) anywhere on the screen: an image is decoded; text outside the
  // code field is read at once (inside it, it just fills the field).
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const data = e.clipboardData;
      if (!data) return;
      const file = Array.from(data.files).find((f) => f.type.startsWith('image/'));
      if (file) {
        e.preventDefault();
        void fromImage(file);
        return;
      }
      if ((e.target as HTMLElement | null)?.closest?.('textarea, input')) return;
      const value = data.getData('text/plain').trim();
      if (value) {
        e.preventDefault();
        setProblem(null);
        go(value);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setProblem(null);
    if (text.trim()) go(text.trim());
  };

  if (secret)
    return (
      <Screen back title={s.title}>
        <div className="mt-4 flex flex-col gap-4 rounded-[20px] bg-bad-soft p-5" role="alert">
          <Icon name="alert" size={32} className="text-bad" />
          <h2 className="text-[1.35rem] text-bad">{s.secretTitle}</h2>
          <p className="text-ink">{s.secretBody}</p>
          <button
            type="button"
            className="btn btn-ink btn-lg"
            onClick={() => {
              setSecret(false);
              handled.current = false;
            }}
          >
            {s.secretOk}
          </button>
        </div>
      </Screen>
    );

  return (
    <Screen
      back
      title={s.title}
      width="page"
      action={
        torch !== null && (
          <button
            type="button"
            className="btn btn-quiet size-11 px-0"
            aria-pressed={torch}
            aria-label={torch ? s.torchOff : s.torchOn}
            onClick={() => void toggleTorch()}
          >
            <Icon name="torch" size={22} />
          </button>
        )
      }
    >
      {/* Wide screens: the camera on the left, pasting, uploading and typing on the right. */}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,460px)_minmax(0,1fr)] lg:items-start lg:gap-10">
        <div className="flex flex-col gap-4">
          <div className="scan-frame mt-1">
            <video ref={video} playsInline muted aria-label={s.hint} />
            {camera === 'on' && <div className="scan-finder" aria-hidden="true" />}
            {camera === 'starting' && (
              <p
                className="absolute inset-0 flex items-center justify-center gap-2 text-white"
                role="status"
              >
                <Spinner />
                {s.starting}
              </p>
            )}
            {(camera === 'denied' || camera === 'none') && (
              <p className="absolute inset-0 flex items-center justify-center p-6 text-center text-white">
                {camera === 'denied' ? s.denied : s.noCamera}
              </p>
            )}
            {camera === 'on' && (
              <p className="absolute inset-x-0 bottom-4 text-center text-[0.9375rem] font-semibold text-white">
                {s.hint}
              </p>
            )}
          </div>

          {problem && (
            <div className="mt-4 flex flex-col gap-2">
              <Notice tone="error" stay>{problem}</Notice>
              <button
                type="button"
                className="btn btn-line self-start"
                onClick={() => {
                  setProblem(null);
                  handled.current = false;
                }}
              >
                {s.again}
              </button>
            </div>
          )}
        </div>
        <div className="flex flex-col lg:pt-1">
          <div className="grid grid-cols-2 gap-2 lg:mt-0">
            <button
              type="button"
              className="btn btn-line btn-lg px-3"
              onClick={() => void pasteQr()}
              disabled={!token || !network}
            >
              <Icon name="clipboard" size={20} />
              {s.paste}
            </button>
            <label className="btn btn-line btn-lg cursor-pointer px-3">
              <Icon name="image" size={20} />
              {s.gallery}
              <input
                type="file"
                accept="image/*"
                className="sr-only"
                onChange={(e) => void fromImage(e.target.files?.[0])}
              />
            </label>
          </div>

          <form className="mt-5 flex flex-col gap-3" onSubmit={submit}>
            <TextArea
              label={s.pasteLabel}
              rows={2}
              value={text}
              onChange={(e) => setText(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="submit"
              className="btn btn-ink btn-lg"
              disabled={!text.trim() || !token || !network}
            >
              {s.read}
            </button>
          </form>
        </div>
      </div>
    </Screen>
  );
}
