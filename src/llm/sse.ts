/**
 * Minimal SSE (text/event-stream) reader over a fetch body.
 * Yields the payload of each `data:` line; stops on `[DONE]`.
 */
export async function* readSSE(response: Response): AsyncGenerator<string> {
  const body = response.body
  if (!body) throw new Error('Response has no body')
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload) continue
      if (payload === '[DONE]') return
      yield payload
    }
  }
}
