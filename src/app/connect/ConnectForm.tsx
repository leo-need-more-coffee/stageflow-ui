/**
 * Which backend to talk to.
 *
 * The editor has no stages and runs nothing itself, so before the canvas it
 * asks for the address of a StageFlow backend. The check is `GET /api/stages`,
 * the request the editor needs anyway: "connected" means the backend answers
 * and allows this origin. The decisions (what to try first, which credential
 * goes with which address) are in `core/connection.js`; this is the form.
 */
import { ChevronRight, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { DEFAULT_AUTH_HEADER } from "@/core/backend.js";
import { EXAMPLE_URL, attemptConnection, credentialFor, initialConnection } from "@/core/connection.js";
import { pieces, t, tn } from "@/core/i18n.js";
import { Button, cn, Input, Label } from "@/ui/kit";

export interface ConnectProps {
  storageKey: string | null;
  url?: string | null;
  plan?: string | null;
  force?: boolean;
  onConnected: (backend: any) => void;
  onCancel?: () => void;
}

export function ConnectForm({ storageKey, url = null, plan = null, force = false, onConnected, onCancel }: ConnectProps) {
  const start = useRef(initialConnection({ storageKey, url, plan, force })).current;
  const [address, setAddress] = useState(start.url || "");
  const [header, setHeader] = useState(start.auth.header || DEFAULT_AUTH_HEADER);
  const [value, setValue] = useState(start.auth.value || "");
  const [authOpen, setAuthOpen] = useState(Boolean(start.auth.value));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; tone: "ok" | "bad" | "wait" } | null>(null);
  const typedCredential = useRef(false);
  const addressInput = useRef<HTMLInputElement>(null);
  const valueInput = useRef<HTMLInputElement>(null);

  const attempt = async (raw: string, silent = false) => {
    if (busy) return;
    setBusy(true);
    setStatus({ text: t("connect.connecting", { address: raw }), tone: "wait" });
    try {
      const { backend, count } = await attemptConnection(storageKey, raw, { header, value }, start.plan);
      setStatus({ text: tn("connect.connected", count), tone: "ok" });
      onConnected(backend);
    } catch (err: any) {
      if (err.badAddress) {
        setStatus({ text: t("connect.badAddress"), tone: "bad" });
        addressInput.current?.focus();
      } else {
        const reason = err.message ?? String(err);
        setStatus({
          text: silent ? t("connect.silentFail", { address: err.address, reason })
            : t("connect.fail", { address: err.address, reason }),
          tone: "bad",
        });
        if (err.credential) {
          setAuthOpen(true);
          setTimeout(() => valueInput.current?.focus());
        } else {
          addressInput.current?.select();
        }
      }
    } finally {
      setBusy(false);
    }
  };

  // a remembered address, or one from the link, is tried at once
  useEffect(() => {
    if (start.url) void attempt(start.url, true);
    else addressInput.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const note = pieces("connect.none", ["command", "repo"], { url: EXAMPLE_URL });

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void attempt(address); }}>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="sf-backend">{t("app.connect.address")}</Label>
        <div className="flex gap-2">
          <Input ref={addressInput} id="sf-backend" name="backend" mono autoComplete="url" placeholder={EXAMPLE_URL}
            value={address} disabled={busy}
            onChange={(e) => {
              setAddress(e.target.value);
              // the credential fields follow the address until somebody types in them
              if (!typedCredential.current) {
                const known = credentialFor(storageKey, e.target.value);
                setHeader(known.header);
                setValue(known.value);
              }
            }} />
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            {t("connect.go")}
          </Button>
        </div>
      </div>

      <div>
        <button type="button" onClick={() => setAuthOpen(!authOpen)}
          className="flex items-center gap-1 text-[12.5px] text-muted hover:text-fg">
          <ChevronRight size={14} className={cn("transition-transform", authOpen && "rotate-90")} />
          {t("conn.auth")}
          <span className="text-subtle">{t(value ? "connect.auth.set" : "connect.auth.optional")}</span>
        </button>
        {authOpen
          ? (
            <div className="mt-2 flex flex-col gap-2">
              <div className="flex gap-2">
                <Input mono name="auth-header" autoComplete="off" className="w-[150px]" placeholder={DEFAULT_AUTH_HEADER}
                  value={header} onChange={(e) => { typedCredential.current = true; setHeader(e.target.value); }} />
                <Input ref={valueInput} mono name="auth-value" type="password" autoComplete="off" className="flex-1"
                  placeholder="Bearer …" value={value}
                  onChange={(e) => { typedCredential.current = true; setValue(e.target.value); }} />
              </div>
              <p className="text-[12px] text-subtle">{t("connect.auth.note")}</p>
            </div>
          )
          : null}
      </div>

      {status
        ? (
          <div className={cn("rounded-md px-3 py-2 text-[12.5px]",
            status.tone === "bad" ? "bg-bad/10 text-bad" : status.tone === "ok" ? "bg-ok/10 text-ok" : "bg-surface-2 text-muted")}>
            {status.text}
          </div>
        )
        : null}

      <p className="text-[12px] leading-relaxed text-subtle">
        {note.map((piece: any, i: number) => (typeof piece === "string"
          ? <span key={i}>{piece}</span>
          : piece.slot === "command"
            ? <code key={i} className="rounded bg-surface-2 px-1 font-mono text-[11.5px] text-muted">python main.py</code>
            : <a key={i} className="text-accent hover:underline" href="https://github.com/leo-need-more-coffee/stageflow-example"
                target="_blank" rel="noreferrer noopener">stageflow-example</a>))}
      </p>

      {onCancel
        ? <div className="flex justify-end"><Button onClick={onCancel}>{t("common.cancel")}</Button></div>
        : null}
    </form>
  );
}
