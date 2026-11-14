export function validate(flow: {
  name: string; purpose: string; trigger: string; channel: string; windowStart: string; windowEnd: string
  daily: number; weekly: number; cooldownDays: number; entry: string; nodes: Array<{ id: string; type: string; name: string }>
}, publish?: boolean): Array<{ message: string; nodeId: string | null }>

export function simulate(
  flow: Parameters<typeof validate>[0],
  person: {
    zone: string; cutoff: string; start: string; bookingAt: string; dayCount: number; weekCount: number
    tags: string[]; values: Record<string,string>
  }
): {
  errors: Array<{ message: string; nodeId?: string | null }>
  events: Array<{ id: string; type: string; name: string; at: string; state: string; detail: string; message?: string }>
  count: number
}
