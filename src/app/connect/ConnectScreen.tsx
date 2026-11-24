import { t } from "@/core/i18n.js";
import { VERSION } from "@/core/version.js";

import { ConnectForm, type ConnectProps } from "./ConnectForm";

/** The first screen: which backend to work with. */
export function ConnectScreen(props: ConnectProps) {
  return (
    <div className="flex min-h-full items-center justify-center bg-bg p-6 text-fg">
      <div className="w-[min(480px,100%)]">
        <div className="mb-6 flex items-center gap-2.5">
          <svg width="28" height="28" viewBox="0 0 16 16" aria-hidden>
            <path d="M8 1.5 14.5 8 8 14.5 1.5 8z" fill="none" stroke="var(--accent)" strokeWidth="1.6" strokeLinejoin="round" />
            <path d="M8 5.5 10.5 8 8 10.5 5.5 8z" fill="var(--accent)" />
          </svg>
          <div>
            <div className="text-[17px] font-semibold tracking-tight">StageFlow</div>
            <div className="text-[12px] text-subtle">{t("app.connect.editor")} · v{VERSION}</div>
          </div>
        </div>
        <div className="rounded-xl border border-border bg-surface p-6 shadow-card">
          <h1 className="mb-1 text-[15px] font-semibold">{t("app.connect.title")}</h1>
          <p className="mb-5 text-[13px] leading-relaxed text-muted">{t("connect.lead")}</p>
          <ConnectForm {...props} />
        </div>
      </div>
    </div>
  );
}
