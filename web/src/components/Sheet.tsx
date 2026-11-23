import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

/** Plain dialog in the mockup's style: 12px radius, 1.25rem padding, own header row. */
export function PlainDialog({ open, onOpenChange, title, label, children, className }: {
  open: boolean; onOpenChange: (o: boolean) => void; title?: string; label?: string; children: React.ReactNode; className?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} aria-describedby={undefined}
        className={cn('block w-[min(520px,92vw)] max-w-none sm:max-w-none rounded-xl border-zinc-300 p-5 gap-0 shadow-lg', className)}>
        {title ? (
          <div className="flex items-center justify-between mb-3">
            <DialogTitle className="font-semibold text-lg">{title}</DialogTitle>
            <button className="link !no-underline" onClick={() => onOpenChange(false)} aria-label="Close">✕</button>
          </div>
        ) : (
          <DialogTitle className="sr-only">{label}</DialogTitle>
        )}
        {children}
      </DialogContent>
    </Dialog>
  );
}

/** The mockup's "sheet" dialog (Settings, agent prompt): no padding, header bar, rounded 14px. */
export function SheetDialog({ open, onOpenChange, title, subtitle, children, footer, width = 'w-[min(480px,94vw)]', container }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; subtitle?: string; children: React.ReactNode;
  footer?: React.ReactNode; width?: string; container?: HTMLElement | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} container={container} aria-describedby={subtitle ? undefined : undefined}
        className={cn('block max-w-none sm:max-w-none p-0 gap-0 rounded-[14px] border-zinc-300 shadow-[0_20px_50px_rgba(0,0,0,.25)]', width)}>
        <div className={`px-6 pt-5 pb-4 border-b border-zinc-200 flex ${subtitle ? 'items-start' : 'items-center'} justify-between gap-4`}>
          <div>
            <DialogTitle className="text-lg font-semibold">{title}</DialogTitle>
            {subtitle ? <DialogDescription className="text-zinc-600 text-base">{subtitle}</DialogDescription> : null}
          </div>
          <button className="icon-btn" onClick={() => onOpenChange(false)} aria-label="Close">✕</button>
        </div>
        {children}
        {footer}
      </DialogContent>
    </Dialog>
  );
}
