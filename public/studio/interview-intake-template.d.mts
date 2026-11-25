export type IntakeSettings={greeting:string;name:string;station:string;age:string;thanks:string;confirm:string;reminder:string;faqUrl:string;mapUrl:string;reminder3h:boolean}
export const intakeTemplate:Readonly<IntakeSettings>
export const consentPrompt:string
export function intakeVariable(body:string,values:Partial<Record<'name'|'store'|'booking',string>>):string
export function normalizeAnswer(stage:string,raw:unknown):string|null
