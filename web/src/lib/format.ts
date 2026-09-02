export function money(n: number, digits = 3): string {
  return `$${n.toFixed(digits)}`;
}

export function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}
