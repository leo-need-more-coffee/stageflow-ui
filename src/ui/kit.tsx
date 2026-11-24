/**
 * The interface's building blocks: buttons, fields, menus, dialogs.
 *
 * Behaviour (focus, keyboard, positioning) comes from Radix; the looks are
 * here, in one place, so every menu and every field in the editor is the same
 * menu and the same field.
 */
import { clsx, type ClassValue } from "clsx";
import {
  ContextMenu as CM, Dialog as D, DropdownMenu as DM, Popover as P, Tabs as T,
  Tooltip as TT,
} from "radix-ui";
import { ArrowLeft, ArrowRight, Check, ChevronRight, X } from "lucide-react";
import { forwardRef, type ComponentProps, type ReactNode } from "react";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ---------------------------------------------------------------- buttons

type ButtonVariant = "default" | "primary" | "ghost" | "danger" | "outline";
type ButtonSize = "sm" | "md" | "icon" | "icon-sm";

const VARIANTS: Record<ButtonVariant, string> = {
  default: "bg-surface-2 text-fg hover:bg-border border border-border",
  primary: "bg-accent text-accent-fg hover:brightness-110 border border-transparent font-medium",
  ghost: "text-muted hover:text-fg hover:bg-surface-2 border border-transparent",
  danger: "text-bad hover:bg-bad/10 border border-transparent",
  outline: "border border-border text-fg hover:bg-surface-2",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-[12px] gap-1.5 rounded-md",
  md: "h-8 px-3 text-[13px] gap-2 rounded-md",
  icon: "size-8 rounded-md justify-center",
  "icon-sm": "size-6 rounded justify-center",
};

export interface ButtonProps extends ComponentProps<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "default", size = "md", className, type = "button", ...rest }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex items-center whitespace-nowrap transition-colors select-none",
        "disabled:opacity-40 disabled:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        VARIANTS[variant], SIZES[size], className,
      )}
      {...rest}
    />
  ),
);
Button.displayName = "Button";

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cn(
      "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-border",
      "bg-surface-2 px-1 font-sans text-[10.5px] font-medium text-subtle",
      className,
    )}>
      {children}
    </kbd>
  );
}

/**
 * Text with its arrows drawn rather than typed: the web build of JetBrains
 * Mono has no ← or →, and the fallback font's are specks.
 */
export function Arrowed({ text, size = 11 }: { text: string; size?: number }) {
  if (!/[←→]/.test(text)) return <>{text}</>;
  return (
    <>
      {text.split(/([←→])/).map((part, i) => (part === "←"
        ? <ArrowLeft key={i} size={size} strokeWidth={2} className="mx-0.5 inline-block shrink-0 align-[-1px] opacity-60" />
        : part === "→"
          ? <ArrowRight key={i} size={size} strokeWidth={2} className="mx-0.5 inline-block shrink-0 align-[-1px] opacity-60" />
          : part.trim() ? <span key={i}>{part.trim()}</span> : null))}
    </>
  );
}

// ----------------------------------------------------------------- fields

export const fieldClass = cn(
  "w-full rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg",
  "placeholder:text-subtle outline-none transition-colors",
  "hover:border-border-strong focus:border-accent focus:ring-2 focus:ring-[var(--ring)]",
  "disabled:opacity-50",
);

export const Input = forwardRef<HTMLInputElement, ComponentProps<"input"> & { mono?: boolean }>(
  ({ className, mono, ...rest }, ref) => (
    <input ref={ref} spellCheck={false}
      className={cn(fieldClass, "h-8", mono && "font-mono text-[12px]", className)} {...rest} />
  ),
);
Input.displayName = "Input";

export const Textarea = forwardRef<HTMLTextAreaElement, ComponentProps<"textarea"> & { mono?: boolean }>(
  ({ className, mono, ...rest }, ref) => (
    <textarea ref={ref} spellCheck={false}
      className={cn(fieldClass, "py-1.5 resize-y leading-relaxed", mono && "font-mono text-[12px]", className)}
      {...rest} />
  ),
);
Textarea.displayName = "Textarea";

export function NativeSelect({ className, mono, ...rest }: ComponentProps<"select"> & { mono?: boolean }) {
  return (
    <select
      className={cn(fieldClass, "h-8 appearance-none pr-7 bg-no-repeat bg-[right_8px_center]",
        "bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%239a9aa3' stroke-width='2.5'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")]",
        mono && "font-mono text-[12px]", className)}
      {...rest}
    />
  );
}

export function Label({ children, hint, className, htmlFor }:
  { children: ReactNode; hint?: ReactNode; className?: string; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className={cn("flex items-baseline gap-2 text-[12px] text-muted", className)}>
      {/* catalogs write labels in lower case, as they read inside a sentence;
          a bare identifier (on_timeout) is a name and stays as it is */}
      {typeof children === "string" && /^[a-z][a-z0-9_.]*$/.test(children) && children.includes("_")
        ? <span className="font-mono text-[11.5px]">{children}</span>
        : typeof children === "string"
          ? <span className="inline-block first-letter:uppercase">{children}</span>
          : <span>{children}</span>}
      {hint ? <span className="font-mono text-[10.5px] font-normal text-subtle">{hint}</span> : null}
    </label>
  );
}

export function Switch({ checked, onChange, label }:
  { checked: boolean; onChange: (value: boolean) => void; label?: ReactNode }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
      className="inline-flex items-center gap-2 text-[13px] text-fg">
      <span className={cn("relative h-[18px] w-8 rounded-full transition-colors",
        checked ? "bg-accent" : "bg-border-strong")}>
        <span className={cn("absolute top-[2px] size-[14px] rounded-full bg-white shadow transition-[left]",
          checked ? "left-[16px]" : "left-[2px]")} />
      </span>
      {label}
    </button>
  );
}

/** A row of mutually exclusive choices, for two to four short options. */
export function Segmented<V extends string>({ value, options, onChange, className, size = "md" }: {
  value: V;
  options: { value: V; label: ReactNode; title?: string }[];
  onChange: (value: V) => void;
  className?: string;
  size?: "sm" | "md";
}) {
  return (
    <div className={cn("inline-flex rounded-md border border-border bg-surface-2 p-0.5", className)}>
      {options.map((option) => (
        <button key={option.value} type="button" title={option.title}
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-[5px] px-2 font-medium transition-colors",
            size === "sm" ? "h-[22px] text-[11px]" : "h-[26px] text-[12px]",
            option.value === value ? "bg-surface text-fg shadow-card" : "text-muted hover:text-fg",
          )}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Badge({ children, tone = "neutral", className }:
  { children: ReactNode; tone?: "neutral" | "accent" | "ok" | "warn" | "bad" | "info"; className?: string }) {
  const tones = {
    neutral: "bg-surface-2 text-muted border-border",
    accent: "bg-accent-soft text-accent border-transparent",
    ok: "bg-ok/10 text-ok border-transparent",
    warn: "bg-warn/10 text-warn border-transparent",
    bad: "bg-bad/10 text-bad border-transparent",
    info: "bg-info/10 text-info border-transparent",
  };
  return (
    <span className={cn("inline-flex h-5 items-center gap-1 rounded-full border px-2 text-[11px] font-medium",
      tones[tone], className)}>
      {children}
    </span>
  );
}

// ------------------------------------------------------------------ menus

const menuContent = cn(
  "z-50 min-w-[200px] overflow-hidden rounded-lg border border-border bg-surface p-1 text-fg shadow-pop",
  "data-[state=open]:animate-in",
);
const menuItem = cn(
  "relative flex h-8 cursor-default select-none items-center gap-2 rounded-md px-2 text-[13px] outline-none",
  "data-[highlighted]:bg-surface-2 data-[disabled]:opacity-40 [&_svg]:size-4 [&_svg]:text-muted",
);

export const Menu = DM.Root;
export const MenuTrigger = DM.Trigger;

export function MenuContent({ children, align = "start", className, ...rest }:
  ComponentProps<typeof DM.Content>) {
  return (
    <DM.Portal>
      <DM.Content align={align} sideOffset={6} className={cn(menuContent, className)} {...rest}>
        {children}
      </DM.Content>
    </DM.Portal>
  );
}

export function MenuItem({ children, shortcut, icon, danger, className, ...rest }:
  ComponentProps<typeof DM.Item> & { shortcut?: string; icon?: ReactNode; danger?: boolean }) {
  return (
    <DM.Item className={cn(menuItem, danger && "text-bad [&_svg]:text-bad", className)} {...rest}>
      {icon}
      <span className="flex-1 truncate">{children}</span>
      {shortcut ? <span className="ml-4 text-[11px] text-subtle">{shortcut}</span> : null}
    </DM.Item>
  );
}

export function MenuCheck({ children, checked, onCheckedChange }:
  { children: ReactNode; checked: boolean; onCheckedChange: (v: boolean) => void }) {
  return (
    <DM.CheckboxItem checked={checked} onCheckedChange={onCheckedChange} className={cn(menuItem, "pl-8")}
      onSelect={(e) => e.preventDefault()}>
      <DM.ItemIndicator className="absolute left-2 inline-flex"><Check /></DM.ItemIndicator>
      {children}
    </DM.CheckboxItem>
  );
}

export function MenuRadio<V extends string>({ value, options, onChange }:
  { value: V; options: { value: V; label: ReactNode; hint?: ReactNode }[]; onChange: (v: V) => void }) {
  return (
    <DM.RadioGroup value={value} onValueChange={(v) => onChange(v as V)}>
      {options.map((o) => (
        <DM.RadioItem key={o.value} value={o.value} className={cn(menuItem, "pl-8")}
          onSelect={(e) => e.preventDefault()}>
          <DM.ItemIndicator className="absolute left-2 inline-flex"><Check /></DM.ItemIndicator>
          <span className="flex-1">{o.label}</span>
          {o.hint ? <span className="text-[11px] text-subtle">{o.hint}</span> : null}
        </DM.RadioItem>
      ))}
    </DM.RadioGroup>
  );
}

export function MenuSub({ label, icon, children }: { label: ReactNode; icon?: ReactNode; children: ReactNode }) {
  return (
    <DM.Sub>
      <DM.SubTrigger className={cn(menuItem, "data-[state=open]:bg-surface-2")}>
        {icon}
        <span className="flex-1">{label}</span>
        <ChevronRight className="!size-3.5" />
      </DM.SubTrigger>
      <DM.Portal>
        <DM.SubContent sideOffset={4} className={menuContent}>{children}</DM.SubContent>
      </DM.Portal>
    </DM.Sub>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <DM.Label className="px-2 pb-1 pt-2 text-[11px] font-medium text-subtle">{children}</DM.Label>;
}

export function MenuSeparator() {
  return <DM.Separator className="-mx-1 my-1 h-px bg-border" />;
}

// ------------------------------------------------------------ context menu

export const ContextMenu = CM.Root;
export const ContextMenuTrigger = CM.Trigger;

export function ContextMenuContent({ children }: { children: ReactNode }) {
  return (
    <CM.Portal>
      <CM.Content className={menuContent}>{children}</CM.Content>
    </CM.Portal>
  );
}

export function ContextMenuItem({ children, shortcut, icon, danger, ...rest }:
  ComponentProps<typeof CM.Item> & { shortcut?: string; icon?: ReactNode; danger?: boolean }) {
  return (
    <CM.Item className={cn(menuItem, danger && "text-bad [&_svg]:text-bad")} {...rest}>
      {icon}
      <span className="flex-1">{children}</span>
      {shortcut ? <span className="ml-4 text-[11px] text-subtle">{shortcut}</span> : null}
    </CM.Item>
  );
}

export function ContextMenuSeparator() {
  return <CM.Separator className="-mx-1 my-1 h-px bg-border" />;
}

// ---------------------------------------------------------------- popover

export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export const PopoverAnchor = P.Anchor;

export function PopoverContent({ children, className, align = "start", ...rest }:
  ComponentProps<typeof P.Content>) {
  return (
    <P.Portal>
      <P.Content align={align} sideOffset={6}
        className={cn("z-50 rounded-lg border border-border bg-surface text-fg shadow-pop outline-none", className)}
        {...rest}>
        {children}
      </P.Content>
    </P.Portal>
  );
}

// ----------------------------------------------------------------- dialog

export function Dialog({ open, onOpenChange, title, description, children, className, footer }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/30 backdrop-blur-[1px]" />
        <D.Content className={cn(
          "fixed left-1/2 top-[12vh] z-50 w-[min(520px,calc(100vw-32px))] -translate-x-1/2",
          "rounded-xl border border-border bg-surface shadow-pop outline-none", className,
        )}>
          <div className="flex items-start gap-3 border-b border-border px-5 py-4">
            <div className="min-w-0 flex-1">
              <D.Title className="text-[15px] font-semibold">{title}</D.Title>
              {description
                ? <D.Description className="mt-1 text-[13px] text-muted">{description}</D.Description>
                : <D.Description className="sr-only">{title}</D.Description>}
            </div>
            <D.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close"><X /></Button>
            </D.Close>
          </div>
          <div className="max-h-[60vh] overflow-auto px-5 py-4">{children}</div>
          {footer ? <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div> : null}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

// ---------------------------------------------------------------- tooltip

export const TooltipProvider = TT.Provider;

export function Tip({ children, content, side = "bottom", shortcut }:
  { children: ReactNode; content: ReactNode; side?: "top" | "bottom" | "left" | "right"; shortcut?: string }) {
  if (!content) return <>{children}</>;
  return (
    <TT.Root>
      <TT.Trigger asChild>{children}</TT.Trigger>
      <TT.Portal>
        <TT.Content side={side} sideOffset={6}
          className="z-[60] flex max-w-[320px] items-center gap-2 rounded-md bg-fg px-2 py-1 text-[12px] text-bg shadow-pop">
          <span>{content}</span>
          {shortcut ? <span className="opacity-60">{shortcut}</span> : null}
        </TT.Content>
      </TT.Portal>
    </TT.Root>
  );
}

// ------------------------------------------------------------------- tabs

export const Tabs = T.Root;

export function TabList({ children, className }: { children: ReactNode; className?: string }) {
  return <T.List className={cn("flex gap-4 border-b border-border px-4", className)}>{children}</T.List>;
}

export function Tab({ value, children }: { value: string; children: ReactNode }) {
  return (
    <T.Trigger value={value} className={cn(
      "-mb-px h-9 border-b-2 border-transparent text-[13px] font-medium text-muted transition-colors",
      "hover:text-fg data-[state=active]:border-fg data-[state=active]:text-fg",
    )}>
      {children}
    </T.Trigger>
  );
}

export const TabPanel = T.Content;
