import { useContext, useEffect, useState } from 'react'
import { api } from '../api'
import { LangContext } from '../i18n'

/**
 * Shared bits of the self-contained cost views (CostMeter, CostBoard): the data
 * shape of GET /api/manage/cost, a loader that refreshes while visible, and the
 * views' own English/Arabic strings. Nothing here depends on the app layout, so
 * the UI session can place <CostMeter/> and <CostBoard/> anywhere.
 */

export interface CostStatus {
  configured: boolean
  unit: 'none' | 'tokens' | 'usd' | 'percent'
  used: number
  limit: number | null
  percent: number | null
  unknownCalls: number
  level: 'ok' | 'warn' | 'high' | 'critical' | 'unknown'
  resetsAt: string | null
  ratePerHour: number | null
  hoursLeft: number | null
  lastsUntilReset: boolean
  calibration: { tokensPerPercent: number | null; readings: number }
  message: string
}

export interface CostSavings {
  calls: number
  comparedCalls: number
  unknownCalls: number
  actualTokens: number
  baselineTokens: number
  tokensSavedPercent: number | null
  usdCoveredCalls: number
  actualUsd: number | null
  baselineUsd: number | null
  usdSavedPercent: number | null
  byTier: { strong: number; standard: number; cheap: number; unrouted: number }
  method: string
}

export interface CostBoardData {
  limits: {
    unit: 'none' | 'tokens' | 'usd' | 'percent'
    amount: number
    window: { kind: 'rolling' | 'day' | 'week' | 'month'; hours: number }
    warnAt: number[]
    autoEco: boolean
    ecoAt: number
    cachedWeight: number
    readings: Array<{ at: string; percent: number }>
  }
  status: CostStatus
  savings: { day: CostSavings; week: CostSavings; all: CostSavings }
  routing: { enabled: boolean; floor: 'cheap' | 'standard' | 'strong'; escalateOnFailure: boolean; tiers: Record<'strong' | 'standard' | 'cheap', { model: string; provider?: string } | null>; cheapModelLegacy: string }
  context: { summarize: boolean; toolOutputChars: number; smartRead: boolean }
}

/** Loads the board and refreshes it every `everyMs` while mounted. `reload` re-reads now. */
export function useCostBoard(everyMs = 20_000): { data: CostBoardData | null; error: string; reload: () => void; set: (d: CostBoardData) => void } {
  const [data, setData] = useState<CostBoardData | null>(null)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    const load = (): void => {
      api<CostBoardData>('GET', '/api/manage/cost')
        .then((d) => {
          if (live) {
            setData(d)
            setError('')
          }
        })
        .catch((e: Error) => live && setError(e.message))
    }
    load()
    const id = setInterval(load, everyMs)
    return () => {
      live = false
      clearInterval(id)
    }
  }, [everyMs, tick])
  return { data, error, reload: () => setTick((n) => n + 1), set: setData }
}

const en = {
  title: 'Your limit',
  noLimit: 'No limit set. Tell VARA your limit to see how long it lasts.',
  used: 'used',
  of: 'of',
  resets: 'resets',
  setLimit: 'Set my limit',
  unit: 'Unit',
  tokens: 'Tokens',
  usd: 'Dollars',
  percent: 'Plan percentage',
  none: 'No limit',
  amount: 'Amount',
  window: 'Window',
  rolling: 'Rolling hours',
  day: 'Day',
  week: 'Week',
  month: 'Month',
  hours: 'hours',
  save: 'Save',
  saved: 'Saved',
  reading: 'My plan shows (%)',
  addReading: 'Add reading',
  readingHelp: 'Type the percentage your provider shows now, then again later. Two readings teach VARA how many tokens are 1% of your plan.',
  eco: 'Auto-eco near the limit',
  ecoHelp: 'Opt-in. From the threshold, routine turns use a lighter model tier. It never goes below your quality floor.',
  ecoAt: 'Start at (%)',
  savings: 'What VARA saved',
  session: 'This session',
  last24: 'Last 24 hours',
  last7: 'Last 7 days',
  allTime: 'All time',
  tokensSaved: 'limit units saved',
  moreThan: 'more than the baseline',
  usdSaved: 'dollars saved',
  unknown: 'unknown',
  calls: 'model calls',
  unreported: 'calls did not report usage (left out, not counted as zero)',
  method: 'How the baseline is estimated',
  routing: 'Which model for which turn',
  floor: 'Quality floor (work turns never go below it)',
  tierStrong: 'Strong (planning, escalation)',
  tierStandard: 'Standard (everyday work)',
  tierCheap: 'Cheap (chat, questions, summaries)',
  modelId: 'model id',
  provider: 'provider (optional)',
  default: 'default: session model',
  escalate: 'Escalate to a stronger tier after a failure',
  context: 'Context',
  summarize: 'Fold old turns into a summary (needs a cheap tier)',
  smartRead: 'Long files come back as an outline',
  outChars: 'Command output kept (characters)',
  pace: 'Pace',
  perHour: 'per hour',
  lasts: 'lasts about',
  lastsReset: 'lasts until the window resets',
  noPace: 'not enough recent activity',
  editing: 'Settings',
}
export type CostKey = keyof typeof en

const ar: Record<CostKey, string> = {
  title: 'حدّك',
  noLimit: 'لم يُحدَّد حد. أخبر VARA بحدّك لترى كم سيدوم.',
  used: 'مستهلك',
  of: 'من',
  resets: 'يتجدد',
  setLimit: 'تحديد حدّي',
  unit: 'الوحدة',
  tokens: 'توكنات',
  usd: 'دولارات',
  percent: 'نسبة الخطة',
  none: 'بلا حد',
  amount: 'المقدار',
  window: 'النافذة',
  rolling: 'ساعات متحركة',
  day: 'يوم',
  week: 'أسبوع',
  month: 'شهر',
  hours: 'ساعات',
  save: 'حفظ',
  saved: 'تم الحفظ',
  reading: 'خطتي تعرض (%)',
  addReading: 'إضافة قراءة',
  readingHelp: 'اكتب النسبة التي يعرضها مزوّدك الآن، ثم مرة أخرى لاحقاً. قراءتان تعلّمان VARA كم توكن يساوي 1٪ من خطتك.',
  eco: 'وضع التوفير التلقائي قرب الحد',
  ecoHelp: 'اختياري. من العتبة فصاعداً تستخدم الأدوار الروتينية طبقة نموذج أخف، ولا تنزل أبداً تحت حدّ الجودة الذي حددته.',
  ecoAt: 'يبدأ عند (%)',
  savings: 'ما وفّره VARA',
  session: 'هذه الجلسة',
  last24: 'آخر 24 ساعة',
  last7: 'آخر 7 أيام',
  allTime: 'كل الوقت',
  tokensSaved: 'وحدات حد موفَّرة',
  moreThan: 'أكثر من خط الأساس',
  usdSaved: 'دولارات موفَّرة',
  unknown: 'غير معروف',
  calls: 'استدعاء للنموذج',
  unreported: 'استدعاءات لم تُبلغ عن استهلاكها (مستثناة، لا تُحسب صفراً)',
  method: 'كيف يُقدَّر خط الأساس',
  routing: 'أي نموذج لأي دور',
  floor: 'حدّ الجودة (أدوار العمل لا تنزل تحته)',
  tierStrong: 'قوي (التخطيط والتصعيد)',
  tierStandard: 'عادي (العمل اليومي)',
  tierCheap: 'رخيص (الدردشة والأسئلة والملخصات)',
  modelId: 'معرّف النموذج',
  provider: 'المزوّد (اختياري)',
  default: 'الافتراضي: نموذج الجلسة',
  escalate: 'التصعيد إلى طبقة أقوى بعد الفشل',
  context: 'السياق',
  summarize: 'طيّ الأدوار القديمة في ملخص (يحتاج طبقة رخيصة)',
  smartRead: 'الملفات الطويلة تعود كمخطط',
  outChars: 'ما يُبقى من مخرجات الأوامر (حرفاً)',
  pace: 'الوتيرة',
  perHour: 'في الساعة',
  lasts: 'يدوم نحو',
  lastsReset: 'يدوم حتى تتجدد النافذة',
  noPace: 'نشاط حديث غير كافٍ',
  editing: 'الإعدادات',
}

export function useCostT(): (k: CostKey) => string {
  const { lang } = useContext(LangContext)
  return (k) => (lang === 'ar' ? ar[k] : en[k])
}

export function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n))
}

export function fmtUsd(n: number | null): string | null {
  return n === null ? null : `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`
}

export function levelColor(level: CostStatus['level']): string {
  return level === 'critical' ? 'var(--err)' : level === 'high' ? 'var(--warn)' : level === 'warn' ? 'var(--warn)' : level === 'ok' ? 'var(--ok)' : 'var(--muted)'
}
