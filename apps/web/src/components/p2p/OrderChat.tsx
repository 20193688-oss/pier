/* OrderChat: an order's chat between the person and the merchant, and the transfer receipts they
   send in it (src/lib/p2p/chat.ts). It reads the messages again every few seconds while the page
   is visible, keeps the newest in view, and remembers what this browser already showed (the
   unread dot on lists reads the same mark). A receipt shows its preview in the bubble and in the
   composer before it goes (src/components/p2p/ReceiptFile.tsx), and opens in a sheet at reading
   size, downloadable. A second tap on send while one is going is dropped. */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  FilePreview,
  readPicked,
  usePickedUrl,
  useReceiptUrl,
  type PickedFile,
} from '@/components/p2p/ReceiptFile';
import { fmt, useI18n } from '@/i18n';
import { Icon } from '@/components/ui/Icon';
import { Dialog } from '@/components/ui/Dialog';
import { Notice, Spinner } from '@/components/ui/controls';
import { chat, sideOf, type ChatScope } from '@/lib/api/chat';
import type { Scope } from '@/lib/api/endpoints';
import { isNotFound } from '@/lib/api/messages';
import { CHAT_TEXT_MAX, fileSize, type ChatMessage } from '@/lib/p2p/chat';
import { markSeen } from '@/lib/p2p/chat-seen';
import { dateTime, timeOnly } from '@/lib/format';

const POLL_MS = 4000;

export function OrderChat({
  scope,
  orderId,
  org,
  className = '',
}: {
  scope: ChatScope;
  orderId: string;
  /* A dashboard's organization and tier (the merchant's or an integrator's side). */
  org?: Scope;
  className?: string;
}) {
  const { t, lang } = useI18n();
  const c = t.p2p.chat;
  const me = sideOf(scope);
  const [messages, setMessages] = useState<ChatMessage[] | undefined>(undefined);
  const [unavailable, setUnavailable] = useState(false);
  const [text, setText] = useState('');
  const [file, setFile] = useState<PickedFile | null>(null);
  const fileUrl = usePickedUrl(file);
  const sendingRef = useRef(false);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [open, setOpen] = useState<ChatMessage | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const lastId = useRef<string | null>(null);

  const load = useCallback(
    () =>
      chat.list(scope, orderId, org).then(
        (list) => {
          setMessages(list);
          setUnavailable(false);
        },
        (e) => {
          if (isNotFound(e)) setUnavailable(true);
          setMessages((m) => m ?? []);
        },
      ),
    // The organization and tier, not the object (a new one each render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scope, orderId, org?.org, org?.tier],
  );

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      void load().finally(() => {
        if (alive) timer = setTimeout(tick, document.hidden ? POLL_MS * 4 : POLL_MS);
      });
    };
    tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  // Keep the newest message in view, and mark what was shown as seen.
  useEffect(() => {
    if (!messages?.length) return;
    const last = messages[messages.length - 1];
    if (last.id !== lastId.current) {
      lastId.current = last.id;
      const el = listRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
    markSeen(scope, orderId, last.createdAt);
  }, [messages, scope, orderId]);

  const pick = async (f: File | undefined) => {
    setError('');
    if (!f) return;
    const r = await readPicked(f);
    if (r === 'type' || r === 'size') {
      if (fileRef.current) fileRef.current.value = '';
      return setError(r === 'type' ? c.badType : c.tooBig);
    }
    setFile(r);
  };

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const body = text.trim();
    if ((!body && !file) || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setError('');
    try {
      const m = await chat.send(
        scope,
        orderId,
        {
          ...(body ? { text: body } : {}),
          ...(file
            ? { attachment: { name: file.name, contentType: file.contentType, data: file.data } }
            : {}),
        },
        org,
      );
      setMessages((list) => [...(list ?? []).filter((x) => x.id !== m.id), m]);
      setText('');
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
    } catch {
      setError(c.sendFailed);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const title = me === 'creator' ? c.title : c.titleMerchant;
  const them = me === 'creator' ? c.merchant : c.customer;

  return (
    <section
      className={`sheet flex min-h-0 flex-col overflow-hidden ${className}`}
      aria-labelledby={`chat-h-${orderId}`}
    >
      <header className="flex items-center gap-3 border-b border-line px-5 py-4">
        <span className="icon-tile" aria-hidden="true">
          <Icon name="chat" size={19} strokeWidth={2.1} />
        </span>
        <div className="min-w-0">
          <h2 id={`chat-h-${orderId}`} className="text-[1.0625rem]">
            {title}
          </h2>
          <p className="text-[0.8125rem] text-ink-3">{c.subtitle}</p>
        </div>
      </header>

      {unavailable ? (
        <div className="p-5">
          <Notice tone="info">{c.unavailable}</Notice>
        </div>
      ) : (
        <ol
          ref={listRef}
          role="log"
          aria-live="polite"
          aria-label={title}
          className="flex max-h-[min(460px,55vh)] min-h-[160px] flex-col gap-3 overflow-y-auto px-4 py-4"
        >
          {messages === undefined ? (
            <li className="m-auto text-ink-3">
              <Spinner />
            </li>
          ) : messages.length === 0 ? (
            <li className="m-auto max-w-[28ch] text-center text-[0.9375rem] text-ink-3">
              {me === 'creator' ? c.empty : c.emptyMerchant}
            </li>
          ) : (
            messages.map((m) => {
              const mine = m.from === me;
              return (
                <li
                  key={m.id}
                  className={`flex max-w-[85%] flex-col gap-1 ${mine ? 'self-end items-end' : 'self-start items-start'}`}
                >
                  <span className="sr-only">{mine ? c.you : them}</span>
                  {m.attachment && (
                    <ReceiptBubble
                      scope={scope}
                      orderId={orderId}
                      org={org}
                      message={m}
                      mine={mine}
                      onOpen={() => setOpen(m)}
                    />
                  )}
                  {m.text && (
                    <p
                      className={`rounded-[18px] px-3.5 py-2 text-[0.9375rem] leading-snug break-words whitespace-pre-wrap ${mine ? 'rounded-br-[6px] bg-ink text-on-ink' : 'rounded-bl-[6px] bg-well'}`}
                    >
                      {m.text}
                    </p>
                  )}
                  <time
                    className="num px-1 text-[0.75rem] text-ink-3"
                    dateTime={m.createdAt}
                    title={dateTime(lang, m.createdAt)}
                  >
                    {timeOnly(lang, m.createdAt)}
                  </time>
                </li>
              );
            })
          )}
        </ol>
      )}

      {!unavailable && (
        <form className="flex flex-col gap-2 border-t border-line p-3" onSubmit={send}>
          {error && <Notice tone="error">{error}</Notice>}
          {file && (
            <div className="flex items-center gap-3 rounded-[14px] bg-well p-2 text-[0.875rem]">
              <div className="w-24 shrink-0" aria-hidden="true">
                <FilePreview url={fileUrl} type={file.contentType} name={file.name} thumb />
              </div>
              <span className="min-w-0 flex-1 truncate">
                {fmt(c.attached, { name: file.name })} · {fileSize(lang, file.size)}
              </span>
              <button
                type="button"
                className="grid size-8 place-items-center rounded-full hover:bg-sheet"
                onClick={() => {
                  setFile(null);
                  if (fileRef.current) fileRef.current.value = '';
                }}
                aria-label={c.remove}
              >
                <Icon name="close" size={16} />
              </button>
            </div>
          )}
          <div className="flex items-end gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,application/pdf"
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => void pick(e.target.files?.[0])}
            />
            <button
              type="button"
              className="grid size-11 shrink-0 place-items-center rounded-full border border-line transition-[border-color,transform] duration-200 hover:border-ink active:scale-95"
              onClick={() => fileRef.current?.click()}
              aria-label={c.attach}
              title={c.attach}
            >
              <Icon name="paperclip" size={19} />
            </button>
            <label className="sr-only" htmlFor={`chat-input-${orderId}`}>
              {c.placeholder}
            </label>
            <textarea
              id={`chat-input-${orderId}`}
              className="field max-h-32 min-h-11 flex-1 resize-none py-2.5"
              rows={1}
              maxLength={CHAT_TEXT_MAX}
              placeholder={c.placeholder}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <button
              type="submit"
              className="btn btn-ink grid size-11 shrink-0 place-items-center rounded-full p-0"
              disabled={sending || (!text.trim() && !file)}
              aria-label={c.send}
              title={c.send}
            >
              {sending ? <Spinner /> : <Icon name="send" size={18} />}
            </button>
          </div>
        </form>
      )}

      {open?.attachment && (
        <ReceiptSheet
          scope={scope}
          orderId={orderId}
          org={org}
          message={open}
          onClose={() => setOpen(null)}
        />
      )}
    </section>
  );
}

/** A receipt in the chat: its preview, its name and size; it opens at reading size. */
function ReceiptBubble({
  scope,
  orderId,
  org,
  message,
  mine,
  onOpen,
}: {
  scope: ChatScope;
  orderId: string;
  org?: Scope;
  message: ChatMessage;
  mine: boolean;
  onOpen: () => void;
}) {
  const { t, lang } = useI18n();
  const c = t.p2p.chat;
  const meta = message.attachment!;
  const file = useReceiptUrl(scope, orderId, message.id, org);
  return (
    <button
      type="button"
      className={`lift flex w-[min(280px,70vw)] flex-col gap-2 rounded-[16px] border p-2 text-left ${mine ? 'border-transparent bg-ink text-on-ink' : 'border-line bg-sheet'}`}
      onClick={onOpen}
      aria-label={`${c.receipt}: ${meta.name}`}
      data-testid="receipt-bubble"
    >
      <FilePreview
        url={file === undefined ? undefined : (file?.url ?? null)}
        type={meta.contentType}
        name={meta.name}
        compact
      />
      <span className="flex min-w-0 items-center gap-2 px-1">
        <Icon name={meta.contentType === 'application/pdf' ? 'file' : 'image'} size={16} />
        <span className="flex min-w-0 flex-col">
          <b className="text-[0.875rem] font-semibold">{c.receipt}</b>
          <span className={`truncate text-[0.75rem] ${mine ? 'opacity-75' : 'text-ink-3'}`}>
            {meta.name} · {fileSize(lang, meta.size)}
          </span>
        </span>
      </span>
    </button>
  );
}

/** A receipt at reading size (one download with its bubble), downloadable. */
function ReceiptSheet({
  scope,
  orderId,
  org,
  message,
  onClose,
}: {
  scope: ChatScope;
  orderId: string;
  org?: Scope;
  message: ChatMessage;
  onClose: () => void;
}) {
  const { t, lang } = useI18n();
  const c = t.p2p.chat;
  const meta = message.attachment!;
  const file = useReceiptUrl(scope, orderId, message.id, org);
  const url = file === undefined ? undefined : (file?.url ?? null);

  return (
    <Dialog
      title={c.receipt}
      onClose={onClose}
      wide
      footer={
        url ? (
          <a className="btn btn-ink" href={url} download={meta.name}>
            <Icon name="download" size={18} />
            {c.download}
          </a>
        ) : null
      }
    >
      <p className="mb-3 text-[0.875rem] text-ink-3">
        {meta.name} · {fileSize(lang, meta.size)} · {dateTime(lang, message.createdAt)}
      </p>
      <FilePreview url={url} type={meta.contentType} name={meta.name} />
      {message.text && <p className="mt-3 text-[0.9375rem]">{message.text}</p>}
    </Dialog>
  );
}
