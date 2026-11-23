import type { ChipSpec, Tone } from '@/lib/wording';
import { cn } from '@/lib/utils';

export function Chip({ spec, className }: { spec: ChipSpec; className?: string }) {
  return (
    <span className={cn('chip', spec.tone, className)}>
      <i aria-hidden="true">{spec.icon}</i>
      {spec.text}
    </span>
  );
}

export function Tag({ tone, children, className }: { tone: Tone; children: React.ReactNode; className?: string }) {
  return <span className={cn('chip chip-xs', tone, className)}>{children}</span>;
}
