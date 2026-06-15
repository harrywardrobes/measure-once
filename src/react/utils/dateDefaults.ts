function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function nowDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function nowTime(): string {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function nowDateTime(): string {
  return `${nowDate()}T${nowTime()}`;
}
