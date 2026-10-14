import { describe, expect, it } from 'vitest'
import { classifyIntent, type Intent } from '../src/core/intent.js'

const cases: Array<[string, Intent]> = [
  // chat — including the typo that started this
  ['hellp', 'chat'],
  ['hello', 'chat'],
  ['hi there', 'chat'],
  ['thanks!', 'chat'],
  ['ok', 'chat'],
  ['test', 'chat'],
  ['who are you?', 'chat'],
  ['how are you', 'chat'],
  ['مرحبا', 'chat'],
  ['اهلا وسهلا', 'chat'],
  ['شكرا لك', 'chat'],
  ['شلونك', 'chat'],
  // questions
  ['how does the login flow work?', 'question'],
  ['what files handle routing', 'question'],
  ['why is the build failing?', 'question'],
  ['explain this project', 'question'],
  ['how do I fix the failing tests', 'question'],
  ['where is the config loaded', 'question'],
  ['list the api endpoints', 'question'],
  ['وين يتم تحميل الاعدادات', 'question'],
  ['اشرح لي كيف يشتغل المشروع', 'question'],
  ['هل يوجد اختبارات للـ auth؟', 'question'],
  // tasks
  ['fix the failing tests', 'task'],
  ['please create a REST api for todos', 'task'],
  ['can you refactor the auth module', 'task'],
  ['add dark mode to the settings page', 'task'],
  ['write unit tests for utils.ts', 'task'],
  ['hello, please fix the bug in login', 'task'],
  ['find the failing test and fix it', 'task'],
  ['اصلح الاخطاء في المشروع', 'task'],
  ['ممكن تضيف صفحة تسجيل دخول', 'task'],
  ['اكتب لي سكربت يحذف الملفات المؤقتة', 'task'],
  ['ابغى تسوي لي موقع بسيط', 'task'],
  // goals
  ['keep the tests passing', 'goal'],
  ['monitor the pull requests and merge safe ones', 'goal'],
  ['check the server every 5 minutes and restart it if it is down', 'goal'],
  ['راقب السيرفر وأعد تشغيله اذا وقف', 'goal'],
  ['خلك تتابع الـ PRs باستمرار', 'goal'],
]

describe('classifyIntent', () => {
  for (const [text, expected] of cases) {
    it(`"${text}" → ${expected}`, () => {
      expect(classifyIntent(text).intent).toBe(expected)
    })
  }

  it('never picks task/goal for a short unclear message (safe by construction)', () => {
    for (const t of ['hmm', 'what', 'x', '??', 'idk', 'yes']) {
      expect(['chat', 'question']).toContain(classifyIntent(t).intent)
    }
  })

  it('defaults a long unclear message to read-only help', () => {
    const g = classifyIntent('the quarterly numbers and the weather in the office feel strange lately')
    expect(g.intent).toBe('question')
    expect(g.confidence).toBe('low')
  })
})
