// Exact money and time arithmetic for billing: amounts are whole agorot
// (integers), rates are decimal strings, rounding is stated, never implied.

// "450", "450.5", "450.50" -> 45000, 45050; null for anything else.
export function toAgorot(rate: string): number | null {
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(rate.trim())
  if (!m) return null
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'))
}

export function formatAgorot(agorot: number): string {
  const sign = agorot < 0 ? '-' : ''
  const a = Math.abs(agorot)
  const whole = Math.floor(a / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${sign}${whole}.${String(a % 100).padStart(2, '0')}`
}

export type Rounding = 'nearest' | 'up' | 'none'

// Minutes worked rounded to the billing increment.
export function billedMinutes(minutes: number, increment: number, rounding: Rounding): number {
  if (rounding === 'none' || increment <= 1) return minutes
  const units = rounding === 'up' ? Math.ceil(minutes / increment) : Math.round(minutes / increment)
  return units * increment
}

// rate x minutes / 60, in agorot, rounded half-up to the agora; `exact` says
// whether any rounding happened.
export function amountFor(rateAgorot: number, minutes: number): { agorot: number; exact: boolean } {
  const num = rateAgorot * minutes
  const q = Math.floor(num / 60)
  const r = num % 60
  return { agorot: r * 2 >= 60 ? q + 1 : q, exact: r === 0 }
}

// "2:08" style.
export function hm(minutes: number): string {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`
}

// Hours as a decimal string, exact for any whole number of minutes that the
// increment allows (15 -> "0.25"); otherwise to two places with a marker.
export function hoursText(minutes: number): string {
  const h = minutes / 60
  const s = h.toFixed(2).replace(/\.?0+$/, '')
  return Number(s) * 60 === minutes ? s : `${h.toFixed(2)}≈`
}
