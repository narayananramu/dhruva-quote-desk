export function TechnicalDetails({ children }: { children: React.ReactNode }) {
  return (
    <details className="mt-6 border-t border-zinc-200 pt-3">
      <summary>Show technical details</summary>
      {children}
    </details>
  );
}

export function TechRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="note">{label}</span> {children}
    </div>
  );
}
