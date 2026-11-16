type Booking = {
  id:string;slot_id:string;status:'confirmed'|'cancelled'|'completed';revision:number;applicant_name:string
  method:'onsite'|'online';starts_at:string;ends_at:string;instructions:string|null
}
type Calendar = {
  today:string;store:string;timezone:string;bookings:Booking[]
  slots:Array<{id:string;starts_at:string;ends_at:string;method:'onsite'|'online';available:boolean}>
}
export function mountInterview(root:HTMLElement,service:{
  demo?:boolean
  calendar(start?:string):Promise<Calendar>
  book(input:{slot:string;name:string}):Promise<Booking>
  change(id:string,input:{action:'cancel'|'reschedule';revision:number;slot?:string}):Promise<Booking>
}):Promise<void>
