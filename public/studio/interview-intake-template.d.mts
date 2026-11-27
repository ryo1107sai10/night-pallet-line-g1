export type UnblockSettings={mode:'same'|'custom'|'off';greeting:string;name:string;station:string;age:string;thanks:string}
export type IntakeSettings={greeting:string;name:string;station:string;age:string;thanks:string;confirm:string;reminder:string;faqUrl:string;mapUrl:string;reminder3h:boolean;unblock?:UnblockSettings}
export const intakeTemplate:Readonly<IntakeSettings>
export function unblockSettings(settings:IntakeSettings):UnblockSettings
export const consentPrompt:string
export function intakeVariable(body:string,values:Partial<Record<'name'|'store'|'booking',string>>):string
export function normalizeAnswer(stage:string,raw:unknown):string|null
