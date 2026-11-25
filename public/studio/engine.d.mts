import type {RichFormat} from './message-format.mjs'
export type BranchRule={condition:'booked'|'consent'|'adult'|'responded'|'tag'|'assigned';tag?:string;negated?:boolean}
export function branchRules(node:{condition:string;tag?:string;rules?:BranchRule[]}):BranchRule[]
export function evaluateBranch(node:{condition:string;tag?:string;rules?:BranchRule[]},states:Record<string,unknown>,tags:string[]):boolean
export const timelineActions:Record<string,string>
export const liveTriggers: Readonly<Record<string,Readonly<Record<string,string>>>>

export function validate(flow: {
  name: string; purpose: string; trigger: string; channel: string; windowStart: string; windowEnd: string
  daily: number; weekly: number; cooldownDays: number; entry: string; nodes: Array<{ id: string; type: string; name: string }>
}, publish?: boolean): Array<{ message: string; nodeId: string | null }>

export function simulate(
  flow: Parameters<typeof validate>[0],
  person: {
    zone: string; cutoff: string; start: string; bookingAt: string; dayCount: number; weekCount: number
    tags: string[]; values: Record<string,string>; timeline?:{afterMinutes:number;action:string;tag?:string;bookingAt?:string}[]
  }
): {
  errors: Array<{ message: string; nodeId?: string | null }>
  events: Array<{ id: string; type: string; name: string; at: string; state: string; detail: string; message?: string; rich?:RichFormat; branch?:'yes'|'no' }>
  count: number
}

export function localPart(instant:number,zone:string): {date:string;time:string}
export function nextWindow(instant:number,flow:{holidays:number[];windowStart:string;windowEnd:string},zone:string): number|null
export function localInstant(value:string,zone:string):number|null
export function waitUntil(node:unknown,at:number,zone:string,cutoff:string,bookingAt:number|null): number|null
export function renderMessage(body:string,person:{values:Record<string,string>;bookingLinkValid:boolean}): {message?:string;reason?:string}
