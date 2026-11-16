export const interval:30
export const defaultHours:Readonly<{start:number;end:number}>
export function clockLabel(minutes:number):string
export function timeOptions(start:number,end:number,includingEnd?:boolean):number[]
export function localTime(instant:Date|string|number,zone:string):{date:string;minutes:number;seconds:number}
export function lastMinute(start:Date|string|number,end:Date|string|number,zone:string):number|null
export function fitsHours(start:Date|string|number,end:Date|string|number,zone:string,hours:{start:number;end:number}):boolean
