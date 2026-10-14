/**
 * Intent routing: what does this message ask for?
 *
 *   chat      greeting, thanks, small talk, "who are you" — answer, no tools
 *   question  asks about the project/world — answer, read-only tools allowed
 *   task      asks for work that changes something — full tools, verified completion
 *   goal      asks for something ongoing — monitor / keep a state, loop until stopped
 *
 * This is the FIRST line of defense: a deterministic, multilingual (English +
 * Arabic) classifier that is safe by construction — when unsure it picks the
 * least powerful intent that can still help (chat/question). The model has the
 * final say through the `escalate` tool, so a wrong guess costs one extra turn,
 * never an unwanted file change.
 */

export type Intent = 'chat' | 'question' | 'task' | 'goal'

export interface IntentGuess {
  intent: Intent
  /** 'high' = a clear signal; 'low' = a fallback guess. */
  confidence: 'high' | 'low'
  reason: string
}

/** JS `\b` is ASCII-only; this boundary also works after Arabic letters. */
const END = String.raw`(?=\s|$|[!.,؟?،:;])`
/** Start of a word, also valid before Arabic letters. */
const START = String.raw`(?:^|\s)`

/** Words that open a polite request but carry no meaning themselves. */
const POLITE_PREFIX = new RegExp(
  String.raw`^(?:please|pls|plz|kindly|can you|could you|would you|will you|can u|i want you to|i need you to|i want to|i need to|i'd like you to|i'd like to|let's|lets|go ahead and|just|ممكن|لو سمحت|من فضلك|تقدر|تقدرين|اريد|أريد|ابغى|أبغى|ابي|أبي|ابغا|بدي|عايز|عاوز|نبي|خلنا|يلا|طيب|لو|ياريت)\s+`,
  'i',
)

const GREETING = new RegExp(
  String.raw`^(?:hi+|hello+|hellp|helo|hey+|heya|yo|sup|howdy|hola|good (?:morning|evening|afternoon|night)|gm|salam|salaam|مرحبا+|مرحبًا|اهلا+|أهلا+|هلا+|هاي|السلام عليكم|سلام|صباح الخير|مساء الخير|يا هلا|حياك|هلا والله)` + END,
  'i',
)
const THANKS = new RegExp(
  String.raw`^(?:thanks?|thank you|thx|ty|cheers|great|nice|cool|awesome|perfect|ok(?:ay)?|k|got it|sounds good|lol|bye|goodbye|شكرا+|شكراً|مشكور|يعطيك العافية|تمام|ممتاز|حلو|اوكي|أوكي|باي|مع السلامة)` + END,
  'i',
)
const ABOUT_AGENT = new RegExp(
  String.raw`^(?:who are you|what are you|what can you do|what do you do|are you (?:there|real|an? \w+)|how are you|how r u|what'?s up|whats up|من انت|من أنت|مين انت|شو تسوي|ماذا تستطيع|وش تقدر|كيف حالك|شلونك|كيفك)` + END,
  'i',
)
/** A bare ping / test message. */
const PING = /^(?:test(?:ing)?|ping|اختبار|\.+|؟+|\?+)$/i

const TASK_VERBS = new RegExp(
  String.raw`\b(?:create|make|build|implement|add|write|fix|update|upgrade|refactor|rewrite|test|debug|install|setup|set up|configure|deploy|run|execute|launch|delete|remove|rename|move|migrate|convert|generate|scaffold|optimi[sz]e|improve|change|edit|modify|patch|commit|push|merge|release|publish|clean|format|lint|translate|port|extract|split|wire|hook up|integrate|replace|revert|resolve|solve|prepare|draft|compose|design|develop|code|program)\b` +
    '|' +
    START +
    String.raw`(?:اصنع|سوي|سوّي|اعمل|اعملي|اضف|أضف|اكتب|اصلح|أصلح|صلح|صلّح|حدث|حدّث|عدل|عدّل|اختبر|جرب|نصب|ركب|شغل|شغّل|نفذ|نفّذ|احذف|امسح|انشئ|أنشئ|انشيء|حسن|حسّن|غير|غيّر|رتب|حول|حوّل|ابني|ابنِ|صمم|صمّم|طور|طوّر|ادمج|انقل|أعد|اعد|ولد|ولّد|برمج|كوّد|كود|ارفع|ادفع|اضبط|جهز|جهّز|رقّع|نظف|نظّف|تضيف|تسوي|تسوّي|تعمل|تكتب|تصلح|تصلّح|تحذف|تمسح|تنشئ|تبني|تشغل|تشغّل|تنفذ|تعدل|تغير|تغيّر|تحسن|تحسّن|تصمم|تطور|تجرب|تنصب|تحدث|تحول|تضبط|تجهز|تنظف|ترتب|تبرمج|تولد)` +
    END,
  'i',
)

/** Real questions: answered from knowledge or by reading — never by changing files. */
const WH_QUESTION = new RegExp(
  '^(?:' +
    String.raw`what|whats|what's|why|how|where|which|who|when|whom|whose|is|are|do|does|did|can|could|should|would|will|explain|describe|tell me|walk me through` +
    '|' +
    String.raw`ما|ماذا|ماهو|ماهي|ليش|لماذا|كيف|وين|اين|أين|من|متى|هل|شو|ايش|إيش|وش|اشرح|وضح|وضّح|فسر|فسّر` +
    ')' +
    END,
  'i',
)
/** Read-only imperatives: "find X", "list Y". Upgraded to a task if a change verb follows. */
const READ_IMPERATIVE = new RegExp(
  '^(?:' +
    String.raw`show me|summari[sz]e|compare|list|find|search|look|read|check|review|analy[sz]e|inspect|open|print|display|show` +
    '|' +
    String.raw`لخص|لخّص|اعرض|ورني|دلني|ابحث|دور|اقرأ|اقرا|افحص|راجع|حلل|قارن` +
    ')' +
    END,
  'i',
)

const GOAL_SIGNALS = new RegExp(
  String.raw`\b(?:keep|continuously|continually|constantly|monitor|watch|forever|indefinitely|until i (?:say|tell)|on an ongoing basis|every \d+ ?(?:s|sec|seconds?|m|min|minutes?|h|hours?|days?)|always make sure|stay on top|babysit|poll)\b` +
    '|' +
    String.raw`(?:باستمرار|دائما|دائماً|دايم|على طول|راقب|راقبي|تابع|ظل|خليك|لحد ما اقول|حتى اقول|كل \d+ ?(?:ثانية|ثواني|دقيقة|دقائق|ساعة|ساعات|يوم|ايام|أيام)|للابد|لا تتوقف)`,
  'i',
)

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

/** Strip a polite prefix (repeatedly) so "can you please fix x" starts with "fix". */
function stripPolite(text: string): string {
  let t = text
  for (let i = 0; i < 3; i++) {
    const next = t.replace(POLITE_PREFIX, '')
    if (next === t) break
    t = next
  }
  return t
}

export function classifyIntent(raw: string): IntentGuess {
  const text = raw.trim().replace(/\s+/g, ' ')
  if (!text) return { intent: 'chat', confidence: 'low', reason: 'empty message' }
  const lower = text.toLowerCase()
  const n = wordCount(lower)
  const body = stripPolite(lower)
  const hasTaskVerb = TASK_VERBS.test(body)

  if (PING.test(lower)) return { intent: 'chat', confidence: 'high', reason: 'ping / test message' }

  // Ongoing work beats everything: "keep the tests green", "راقب السيرفر".
  if (GOAL_SIGNALS.test(lower) && (hasTaskVerb || n >= 4)) {
    return { intent: 'goal', confidence: 'high', reason: 'asks for ongoing monitoring / maintaining a state' }
  }

  // Pure social messages — only when short, so "hello, please fix the bug"
  // still becomes a task below.
  if (n <= 6 && (GREETING.test(lower) || THANKS.test(lower) || ABOUT_AGENT.test(lower)) && !hasTaskVerb) {
    return { intent: 'chat', confidence: 'high', reason: 'greeting / thanks / small talk' }
  }

  // True questions read; they never write ("how do I fix this?" is a question).
  if (WH_QUESTION.test(body)) {
    return { intent: 'question', confidence: 'high', reason: 'asks for information' }
  }

  // "find the failing test and fix it": a read verb plus a change verb is work.
  if (READ_IMPERATIVE.test(body)) {
    return hasTaskVerb
      ? { intent: 'task', confidence: 'low', reason: 'a read request that also asks for a change' }
      : { intent: 'question', confidence: 'high', reason: 'asks to look something up' }
  }

  // An imperative change verb at the start (after politeness) is a clear task.
  const firstWords = body.split(' ').slice(0, 2).join(' ')
  if (TASK_VERBS.test(firstWords)) {
    return { intent: 'task', confidence: 'high', reason: 'imperative request for work' }
  }

  if (/[?؟]\s*$/.test(text)) return { intent: 'question', confidence: 'low', reason: 'ends with a question mark' }

  // A change verb somewhere inside a real sentence.
  if (n >= 4 && hasTaskVerb) {
    return { intent: 'task', confidence: 'low', reason: 'mentions an action in a longer request' }
  }

  // Short and no verb: a greeting, a typo, a test ping ("hellp", "ok").
  if (n <= 3 || text.length <= 14) return { intent: 'chat', confidence: 'low', reason: 'short message with no request' }

  // Long but unclear: answer and let the model ask — never start changing things.
  return { intent: 'question', confidence: 'low', reason: 'unclear request — default to read-only help' }
}

/** Intents that run the full task/goal machinery (tools that change things, verified completion). */
export function isWorkIntent(intent: Intent): boolean {
  return intent === 'task' || intent === 'goal'
}
