/**
 * Schedule specs, parsed by hand (no dependency). Two forms, both in the machine's local time:
 *
 *   every 30m | every 2h | every 1d        a fixed interval after the last run
 *   m h dom mon dow                         five-field cron: numbers, a star, a star with a step, ranges "a-b", lists "a,b"
 *                                           (dow 0-6, 0 = Sunday, 7 also Sunday; dom and dow both given = either matches, as in cron)
 *
 * Anything else is refused with a reason; nothing is guessed.
 */

export type Spec =
  | { kind: 'interval'; minutes: number; text: string }
  | { kind: 'cron'; minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>; domStar: boolean; dowStar: boolean; text: string }

const FIELDS: Array<{ name: string; min: number; max: number }> = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
]

function parseField(src: string, min: number, max: number, name: string): Set<number> {
  const out = new Set<number>()
  for (const part of src.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part)
    if (!m) throw new Error(`Bad ${name} field "${src}".`)
    const step = m[2] ? Number(m[2]) : 1
    if (step < 1) throw new Error(`Bad step in the ${name} field.`)
    let lo = min
    let hi = max
    if (m[1] !== '*') {
      const [a, b] = m[1]!.split('-')
      lo = Number(a)
      hi = b === undefined ? (m[2] ? max : lo) : Number(b)
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`The ${name} field must be between ${min} and ${max}.`)
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out
}

export function parseSpec(text: string, minIntervalMinutes = 5): Spec {
  const t = text.trim().replace(/\s+/g, ' ')
  const every = /^every (\d+)\s*(m|min|h|d)$/i.exec(t)
  if (every) {
    const n = Number(every[1])
    const unit = every[2]!.toLowerCase()
    const minutes = unit === 'd' ? n * 1440 : unit === 'h' ? n * 60 : n
    if (minutes < minIntervalMinutes) throw new Error(`The shortest interval is ${minIntervalMinutes} minutes.`)
    if (minutes > 60 * 24 * 31) throw new Error('The longest interval is 31 days.')
    return { kind: 'interval', minutes, text: t }
  }
  const parts = t.split(' ')
  if (parts.length !== 5) throw new Error('Use "every 30m" / "every 2h" / "every 1d", or five cron fields: minute hour day-of-month month day-of-week (e.g. "0 9 * * 1-5").')
  const sets = parts.map((p, i) => parseField(p, FIELDS[i]!.min, FIELDS[i]!.max, FIELDS[i]!.name))
  const dow = new Set([...sets[4]!].map((d) => (d === 7 ? 0 : d)))
  const spec: Spec = { kind: 'cron', minute: sets[0]!, hour: sets[1]!, dom: sets[2]!, month: sets[3]!, dow, domStar: parts[2]!.startsWith('*'), dowStar: parts[4]!.startsWith('*'), text: t }
  // A cron that can never fire (31 February) is a mistake worth reporting now.
  if (!nextRun(spec, new Date(2024, 0, 1))) throw new Error('That schedule never fires.')
  return spec
}

function dayMatches(s: Extract<Spec, { kind: 'cron' }>, d: Date): boolean {
  const domOk = s.dom.has(d.getDate())
  const dowOk = s.dow.has(d.getDay())
  if (s.domStar && s.dowStar) return true
  if (s.domStar) return dowOk
  if (s.dowStar) return domOk
  return domOk || dowOk
}

/** The next time strictly after `from` (interval: `from` + n minutes). Null only for an impossible cron. */
export function nextRun(spec: Spec, from: Date): Date | null {
  if (spec.kind === 'interval') return new Date(from.getTime() + spec.minutes * 60_000)
  const d = new Date(from.getTime())
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)
  const limit = from.getTime() + 5 * 366 * 86_400_000
  while (d.getTime() <= limit) {
    if (!spec.month.has(d.getMonth() + 1) || !dayMatches(spec, d)) {
      d.setDate(d.getDate() + 1)
      d.setHours(0, 0, 0, 0)
      continue
    }
    if (!spec.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0)
      continue
    }
    if (!spec.minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0)
      continue
    }
    return d
  }
  return null
}
