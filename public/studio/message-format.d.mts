export type RichFormat={kind:'image'|'buttons'|'card';title?:string;imageUrl?:string;buttons:{label:string;url:string}[]}
export function publicHttps(value:unknown):boolean
export function richErrors(rich?:RichFormat,body?:string):string[]
export function lineMessage(body:string,rich?:RichFormat):Record<string,unknown>

export const dynamicButtonUrls:string[]
export function resolveRichButtons(rich:RichFormat|undefined,links:Record<string,string>):RichFormat|undefined
