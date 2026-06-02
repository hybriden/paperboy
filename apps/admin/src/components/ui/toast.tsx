import * as RToast from "@radix-ui/react-toast";
import { createContext, useCallback, useContext, useMemo, useState } from "react";

type Variant = "success" | "error" | "info";
interface ToastItem {
  id: number;
  title: string;
  description?: string;
  variant: Variant;
}
interface ToastApi {
  toast: (t: { title: string; description?: string; variant?: Variant }) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
}

const Ctx = createContext<ToastApi | null>(null);
let counter = 0;

const accentByVariant: Record<Variant, string> = {
  success: "before:bg-published",
  error: "before:bg-danger",
  info: "before:bg-accent",
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const push = useCallback((t: { title: string; description?: string; variant?: Variant }) => {
    counter += 1;
    setItems((prev) => [...prev, { id: counter, variant: "info", ...t }]);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      toast: push,
      success: (title, description) => push({ title, description, variant: "success" }),
      error: (title, description) => push({ title, description, variant: "error" }),
    }),
    [push],
  );

  return (
    <RToast.Provider swipeDirection="right" duration={4200}>
      <Ctx.Provider value={api}>{children}</Ctx.Provider>
      {items.map((t) => (
        <RToast.Root
          key={t.id}
          onOpenChange={(open) => {
            if (!open) setItems((prev) => prev.filter((x) => x.id !== t.id));
          }}
          className={`relative overflow-hidden rounded-lg border border-line bg-panel pl-4 pr-3 py-3 shadow-pop data-[state=open]:animate-toast-in before:absolute before:inset-y-0 before:left-0 before:w-1 ${accentByVariant[t.variant]}`}
        >
          <RToast.Title className="text-sm font-semibold text-fg">{t.title}</RToast.Title>
          {t.description && (
            <RToast.Description className="mt-0.5 text-xs text-muted">{t.description}</RToast.Description>
          )}
        </RToast.Root>
      ))}
      <RToast.Viewport className="fixed bottom-4 right-4 z-[100] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 outline-none" />
    </RToast.Provider>
  );
}

export function useToast(): ToastApi {
  const c = useContext(Ctx);
  if (!c) throw new Error("useToast must be used within ToastProvider");
  return c;
}
