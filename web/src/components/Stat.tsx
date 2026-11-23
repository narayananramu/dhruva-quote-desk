export function Stat({ label, value, note, big, valueClass }: { label: string; value: React.ReactNode; note?: React.ReactNode; big?: boolean; valueClass?: string }) {
  return (
    <div>
      <div className="note">{label}</div>
      <div className={`${big ? 'big' : 'font-semibold'} ${valueClass ?? ''}`}>{value}</div>
      {note != null && <div className="note">{note}</div>}
    </div>
  );
}

export function StatBox({ label, value, note }: { label: string; value: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div className="stat">
      <div className="note">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
      {note != null && <div className="note">{note}</div>}
    </div>
  );
}
