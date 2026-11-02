/**
 * Fact extraction (M1).
 *
 * Two extractors behind one method:
 *
 * - `RuleExtractor` — deterministic regexes for common zh/en self-disclosure.
 *   Offline, no model, and deliberately narrow: it only catches the patterns
 *   below, so it under-extracts rather than inventing facts.
 * - `LLMExtractor` — the prompt is ported from the Python engine unchanged,
 *   including rule 6/7 (never turn "the agent used a tool" into "the user knows
 *   that tool"), because that clause exists to stop a real bad row.
 *
 * Only user turns are mined: an assistant's "I'll remember that" is not a fact.
 */

/** The prompt the Python engine used, verbatim, so behaviour does not drift. */
export const DEFAULT_LLM_PROMPT = (
  '你是记忆抽取器。从下面的对话中抽取关于用户（或智能体）的、长期有效的独立事实，'
  + '要求：1) 每条是一句完整陈述（例如“用户喜欢用中文沟通”），不要时间性问候；'
  + '2) 去掉寒暄、确认语与无法复用的临时信息；3) 不要臆造；'
  + '4) 同一主题必须合并成一条：把同一主体的多个属性写成一句完整陈述'
  + '（例如姓名、学校、年级合成一句，而不是拆成三条），宁少勿多，'
  + '不要把一件事拆成多条琐碎记录；'
  + '6) 只写用户（或智能体）自己陈述过的、关于自身的长期事实；'
  + '不要把助手或工具做过的事、用过的技术方法改写成人的属性'
  + '（反面例：“用户熟悉 Electron 应用的 asar 文件格式结构”是一次操作，不是用户属性）；'
  + '7) 工具、命令、文件格式这类技术做法若确实值得保留，写成过程陈述'
  + '（如“做法：…”），不要写成“用户会 / 掌握 / 熟悉…”；'
  + '8) 只输出 JSON 字符串数组；没有合格事实时必须输出 []，'
  + '宁可输出 [] 也不要凑一条弱事实。对话如下：\n'
)

const RULES = [
  [/(?:我的名字(?:叫|是)|我叫|请叫我)([\u4e00-\u9fa5A-Za-z0-9_]{1,20})/g, '用户的名字是{0}'],
  [/(?<!不)我(?:喜欢|喜爱|偏爱|最爱)(.{1,30})/g, '用户喜欢{0}'],
  [/(?:我不喜欢|我讨厌|我不爱|我忌口)(.{1,30})/g, '用户不喜欢{0}'],
  [/(?:我住在|我来自|我老家在)([\u4e00-\u9fa5A-Za-z0-9_]{1,20})/g, '用户住在{0}'],
  [/(?:我的职业是|我是一名|我是)([\u4e00-\u9fa5A-Za-z0-9_]{2,20})/g, '用户的职业是{0}'],
  [/(?:请记住|记住[：: ]?)\s*(.{2,40})/g, '{0}'],
  [/\b(?:my name is|call me)\s+([A-Za-z0-9_]{1,20})/gi, "user's name is {0}"],
  [/\bi (?:like|love|prefer|enjoy)\s+(.{1,40})/gi, 'user likes {0}'],
  [/\bi (?:don'?t like|hate|dislike)\s+(.{1,40})/gi, 'user dislikes {0}'],
  [/\bi (?:live in|am from)\s+([A-Za-z0-9 _.,'-]{1,30})/gi, 'user lives in {0}'],
  [/\bi work (?:at|for)\s+([A-Za-z0-9 _.,'-]{1,30})/gi, 'user works at {0}'],
  [/\bremember that\s+(.{2,60})/gi, '{0}'],
]

const TAIL = /[。！？；，.\s]+$/
const SPLIT = /[。！？；\n]+/

function clean(fact) {
  return fact.replace(TAIL, '').trim()
}

/** Shared extraction of a JSON array; `null` means "not an array in here". */
function arrayFrom(content) {
  let text = String(content ?? '').trim()
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) text = fenced[1].trim()
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end <= start) return null
  try {
    const data = JSON.parse(text.slice(start, end + 1))
    return Array.isArray(data) ? data : null
  } catch {
    return null
  }
}

/** Tolerant parse of a JSON string array from a model answer. */
export function parseFacts(content) {
  const data = arrayFrom(content)
  if (data === null) return []
  return data.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
}

/**
 * Strict parse for the live pipeline.
 *
 * The tolerant version answers "no facts" for anything it cannot read, which made
 * a model that returned prose (or nothing) indistinguishable from a model that
 * correctly answered `[]` — both surfaced as `ok added=0`. Here an unreadable
 * answer throws, so the diagnostic says `failed: …` with a snippet of what the
 * model actually said. An empty answer is still `[]`: "nothing to store" is a
 * legitimate answer, silence from the model is not.
 */
export function parseFactsStrict(content) {
  const text = String(content ?? '').trim()
  if (text === '') return []
  const data = arrayFrom(text)
  if (data === null) {
    throw new Error(`the model did not return a JSON array: ${text.replace(/\s+/g, ' ').slice(0, 120)}`)
  }
  const facts = data.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
  if (data.length > 0 && facts.length === 0) {
    throw new Error(`the model returned ${data.length} entr${data.length === 1 ? 'y' : 'ies'} that are not strings`)
  }
  return facts
}

function userTexts(messages) {
  return (messages || [])
    .filter((message) => message && message.role === 'user' && typeof message.content === 'string')
    .map((message) => message.content)
}

export class RuleExtractor {
  /** @param {Array} messages @returns {string[]} */
  extract(messages) {
    const facts = []
    const seen = new Set()
    for (const text of userTexts(messages)) {
      for (const sentence of text.split(SPLIT)) {
        if (!sentence.trim()) continue
        for (const [pattern, template] of RULES) {
          pattern.lastIndex = 0
          for (const match of sentence.matchAll(pattern)) {
            const fact = clean(template.replace('{0}', (match[1] ?? '').trim()))
            if (fact && !seen.has(fact)) {
              seen.add(fact)
              facts.push(fact)
            }
          }
        }
      }
    }
    return facts
  }
}

export class LLMExtractor {
  constructor(client, { prompt = DEFAULT_LLM_PROMPT } = {}) {
    this.client = client
    this.prompt = prompt
  }

  async extract(messages, prompt = null) {
    const transcript = userTexts(messages)
      .map((text, index) => `[${index + 1}] ${text}`)
      .join('\n')
    if (!transcript.trim()) return []
    const content = await this.client.complete([
      { role: 'system', content: prompt || this.prompt },
      { role: 'user', content: transcript },
    ])
    // Strict on purpose: an unreadable answer must become a failed diagnostic,
    // not a silent "nothing to store" (see parseFactsStrict).
    return parseFactsStrict(content)
  }
}
