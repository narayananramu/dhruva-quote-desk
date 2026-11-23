import type { BannerSpec } from '@/lib/wording';

/** First line large and bold; later lines normal, the last muted when there are three (mockup "lost"). */
export function Banner({ spec }: { spec: BannerSpec }) {
  const [first, ...rest] = spec.lines;
  return (
    <div className={`banner ${spec.tone}`} role="status">
      <div className="text-lg font-semibold">{first}</div>
      {rest.map((l, i) => (
        <div key={i} className={`mt-1 ${i === 1 ? 'text-zinc-600' : ''}`}>
          {l}
        </div>
      ))}
    </div>
  );
}
