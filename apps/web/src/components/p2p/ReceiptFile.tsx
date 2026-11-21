/* A transfer receipt as a file: picked (an image or a PDF of at most 2 MB, its first bytes checked
   against its type), fetched from an order's chat once and kept for the session, and shown as a
   preview. An image is drawn as it is. A PDF is shown by the browser's own viewer where it has one
   inline (`navigator.pdfViewerEnabled`: desktop browsers, iPhones); elsewhere (Android) it is a
   document card that opens the file. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '@/i18n';
import { Icon } from '@/components/ui/Icon';
import { Spinner } from '@/components/ui/controls';
import { useToast } from '@/components/ui/Toast';
import { chat, type ChatScope } from '@/lib/api/chat';
import type { Scope } from '@/lib/api/endpoints';
import { checkAttachment, fileSize, fromBase64, sniffType, toBase64 } from '@/lib/p2p/chat';

export interface PickedFile {
  name: string;
  contentType: string;
  size: number;
  /* base64 */
  data: string;
}

/** A file the person picked, read and checked: its type by its first bytes too. */
export async function readPicked(f: File): Promise<PickedFile | 'type' | 'size'> {
  const problem = checkAttachment(f);
  if (problem) return problem;
  const bytes = new Uint8Array(await f.arrayBuffer());
  const type = sniffType(bytes);
  if (!type || type !== f.type) return 'type';
  return {
    name: f.name.slice(0, 120) || 'comprobante',
    contentType: type,
    size: f.size,
    data: toBase64(bytes),
  };
}

/** Whether this browser draws a PDF inline (in a frame). */
export const showsPdfInline = () =>
  typeof navigator !== 'undefined' && navigator.pdfViewerEnabled === true;

/** A picked file as a URL to preview it, for as long as it is on screen. */
export function usePickedUrl(file: PickedFile | null): string | null {
  const url = useMemo(
    () =>
      file
        ? URL.createObjectURL(
            new Blob([fromBase64(file.data) as BlobPart], { type: file.contentType }),
          )
        : null,
    [file],
  );
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );
  return url;
}

type Fetched = { url: string; type: string } | null;
/* Receipts already fetched this session, by message: the chat reads its messages every few
   seconds, and a preview and its sheet share one download. */
const fetched = new Map<string, Promise<Fetched>>();

/** A chat message's attachment as a URL (undefined while it downloads, null when it cannot be
    shown: missing, or its bytes are not what it says). */
export function useReceiptUrl(
  scope: ChatScope,
  orderId: string,
  messageId: string,
  org?: Scope,
): Fetched | undefined {
  const [file, setFile] = useState<Fetched | undefined>(undefined);
  const key = `${scope}:${org?.org ?? ''}:${org?.tier ?? ''}:${messageId}`;
  useEffect(() => {
    let alive = true;
    let p = fetched.get(key);
    if (!p) {
      p = chat.attachment(scope, orderId, messageId, org).then(
        (a) => {
          const bytes = fromBase64(a.data);
          // Only the types the chat accepts, checked by their bytes again before showing them.
          const type = sniffType(bytes);
          if (!type || type !== a.contentType) return null;
          return { url: URL.createObjectURL(new Blob([bytes as BlobPart], { type })), type };
        },
        () => null,
      );
      fetched.set(key, p);
      // A failed download may be tried again later.
      void p.then((r) => {
        if (!r) fetched.delete(key);
      });
    }
    void p.then((r) => alive && setFile(r));
    return () => {
      alive = false;
    };
    // The organization and tier, not the object (a new one each render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return file;
}

/** A receipt drawn as a thumbnail (`thumb`, beside the message being written), small (`compact`,
    in a chat bubble or a picker) or at reading size. */
export function FilePreview({
  url,
  type,
  name,
  compact = false,
  thumb = false,
}: {
  url: string | null | undefined;
  type: string;
  name: string;
  compact?: boolean;
  thumb?: boolean;
}) {
  const { t } = useI18n();
  const c = t.p2p.chat;
  if (thumb)
    return url && type !== 'application/pdf' ? (
      <img
        src={url}
        alt={name}
        className="h-16 w-full rounded-[10px] border border-line bg-white object-cover object-top"
      />
    ) : (
      <span className="grid h-16 w-full place-items-center rounded-[10px] border border-line bg-white text-[#0a0b0e]">
        <Icon name="file" size={24} />
      </span>
    );
  const box = compact ? 'h-44 w-full' : 'h-[min(70vh,640px)] w-full';
  if (url === undefined)
    return (
      <div className={`grid place-items-center rounded-[12px] bg-well text-ink-3 ${box}`}>
        <Spinner />
      </div>
    );
  if (url === null)
    return (
      <div
        className={`flex flex-col items-center justify-center gap-2 rounded-[12px] bg-well p-4 text-center text-ink-3 ${compact ? 'h-28' : 'h-48'}`}
      >
        <Icon name="file" size={28} />
        <span className="text-[0.875rem]">{c.openFailed}</span>
      </div>
    );
  if (type !== 'application/pdf')
    return (
      <img
        src={url}
        alt={name}
        className={`rounded-[12px] border border-line bg-white ${compact ? 'h-44 w-full object-cover object-top' : 'mx-auto max-h-[70vh] w-auto'}`}
      />
    );
  if (showsPdfInline())
    return (
      <iframe
        src={`${url}#toolbar=0&navpanes=0&view=FitH`}
        title={name}
        // In a bubble the preview is only a picture of the file: the bubble opens it.
        className={`rounded-[12px] border border-line bg-white ${box} ${compact ? 'pointer-events-none' : ''}`}
        tabIndex={compact ? -1 : undefined}
      />
    );
  return (
    <div
      className={`flex flex-col items-center justify-center gap-2 rounded-[12px] border border-line bg-white p-4 text-center text-[#0a0b0e] ${compact ? 'h-32' : 'h-56'}`}
    >
      <Icon name="file" size={compact ? 30 : 40} />
      <span className="max-w-full truncate text-[0.875rem] font-semibold">{name}</span>
      {!compact && (
        <a className="btn btn-line" href={url} target="_blank" rel="noopener noreferrer">
          <Icon name="external" size={16} />
          {c.openTab}
        </a>
      )}
    </div>
  );
}

/** Picks the receipt file, shows it, and lets it be changed or taken off. */
export function ReceiptPicker({
  value,
  onChange,
  label,
  hint,
}: {
  value: PickedFile | null;
  onChange: (file: PickedFile | null) => void;
  label: string;
  hint?: string;
}) {
  const { t, lang } = useI18n();
  const c = t.p2p.chat;
  const input = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const url = usePickedUrl(value);
  const pick = async (f: File | undefined) => {
    if (!f) return;
    const r = await readPicked(f);
    if (r === 'type' || r === 'size') {
      if (input.current) input.current.value = '';
      return toast(r === 'type' ? c.badType : c.tooBig, 'error');
    }
    onChange(r);
  };
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[0.875rem] font-semibold">{label}</span>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,application/pdf"
        className="sr-only"
        aria-label={label}
        onChange={(e) => void pick(e.target.files?.[0])}
      />
      {value ? (
        <div className="flex flex-col gap-2 rounded-[16px] border border-line p-2">
          <FilePreview url={url} type={value.contentType} name={value.name} compact />
          <div className="flex items-center gap-2 px-1 text-[0.875rem]">
            <Icon name={value.contentType === 'application/pdf' ? 'file' : 'image'} size={16} />
            <span className="min-w-0 flex-1 truncate">
              {value.name} · {fileSize(lang, value.size)}
            </span>
            <button
              type="button"
              className="btn btn-quiet btn-sm"
              onClick={() => input.current?.click()}
            >
              {c.change}
            </button>
            <button
              type="button"
              className="grid size-8 place-items-center rounded-full hover:bg-well"
              onClick={() => {
                onChange(null);
                if (input.current) input.current.value = '';
              }}
              aria-label={c.remove}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="flex flex-col items-center justify-center gap-2 rounded-[16px] border-2 border-dashed border-line-2 px-4 py-6 text-center transition-colors hover:border-ink"
          onClick={() => input.current?.click()}
        >
          <Icon name="paperclip" size={22} />
          <b className="font-semibold">{c.pickReceipt}</b>
          <span className="text-[0.8125rem] text-ink-3">{c.receiptTypes}</span>
        </button>
      )}
      {hint && <p className="text-[0.8125rem] text-ink-3">{hint}</p>}
    </div>
  );
}
