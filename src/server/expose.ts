import { createInterface } from 'node:readline/promises'

export type Exposure = 'local' | 'lan' | 'public' | 'share'

/** Flags that already say how the host is reached: when any is present nobody is asked. */
export function exposureDecided(args: string[], env: Record<string, string | undefined>): boolean {
  const flags = ['--lan', '--public', '--local', '--bind', '--public-host', '--share']
  return flags.some((f) => args.includes(f)) || !!env.VARA_BIND?.trim() || !!env.VARA_PUBLIC_HOST?.trim()
}

/** The arguments a choice stands for. */
export function exposureArgs(choice: Exposure): string[] {
  return choice === 'lan' ? ['--lan'] : choice === 'public' ? ['--public'] : choice === 'share' ? ['--share'] : []
}

/** This machine's address as the internet sees it, or null when it cannot be learned (offline, blocked). */
export async function publicIp(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  for (const url of ['https://api.ipify.org', 'https://ifconfig.me/ip']) {
    try {
      const r = await fetchImpl(url, { signal: AbortSignal.timeout(4000) })
      const t = (await r.text()).trim()
      if (r.ok && /^[\d.]{7,15}$|^[0-9a-f:]{3,39}$/i.test(t)) return t
    } catch {
      /* try the next one */
    }
  }
  return null
}

/** Ask once, in plain words, how this host should be reached. Enter keeps the safe default (this machine only). */
export async function askExposure(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<Exposure> {
  const rl = createInterface({ input, output })
  try {
    output.write(
      [
        '',
        'How do you want to reach VARA?',
        '  1) Only on this machine            (safe default; use an SSH tunnel to reach it from elsewhere)',
        '  2) On my network (LAN)             (phones and laptops on the same Wi-Fi / private network)',
        '  3) From anywhere by this server\'s IP  (a VPS: http://IP:PORT — open the port in the firewall)',
        '  4) A temporary public https link   (a tunnel; closes when you stop VARA)',
        '',
      ].join('\n'),
    )
    const answer = (await rl.question('Choose 1-4 [1]: ')).trim()
    return answer === '2' ? 'lan' : answer === '3' ? 'public' : answer === '4' ? 'share' : 'local'
  } finally {
    rl.close()
  }
}
