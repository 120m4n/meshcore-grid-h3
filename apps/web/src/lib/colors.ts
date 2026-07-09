export function colorForScore(scorePct: number): string {
  // rojo (0%) -> amarillo (50%) -> verde (100%)
  if (scorePct >= 66) return '#2ecc71';
  if (scorePct >= 33) return '#f1c40f';
  return '#e74c3c';
}
