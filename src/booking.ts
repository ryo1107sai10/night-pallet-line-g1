import { z } from 'zod'
import { audit, conflict, Fault, missing, newId, once, revision, text, uuid, type DB, type Actor, type Config } from './core.js'
import { customerById, emitDelivery, type Customer } from './customer.js'
import { lockDispatch } from './dispatch-lock.js'

export const slotInput=z.strictObject({label:text(100),starts_at:z.iso.datetime({offset:true}),
  ends_at:z.iso.datetime({offset:true}),capacity:z.int().min(1).max(200),published:z.boolean()})
const party=z.int().min(1).max(200)
export const bookingInput=z.strictObject({customer:uuid,slot:uuid,party,confirm:z.boolean()})
export const ownBookingInput=bookingInput.pick({slot:true,party:true})
export const bookingChange=z.strictObject({revision,slot:uuid,party,
  status:z.enum(['pending','confirmed','cancelled','visited','no_show']),reason:text(200)})
export const ownBookingChange=bookingChange.pick({revision:true,slot:true,party:true,status:true})
  .refine(data=>['pending','cancelled'].includes(data.status))
export type BookingStatus=z.infer<typeof bookingChange>['status']
type Booking={id:string;tenant_id:string;store_id:string;customer_id:string;slot_id:string;party:number;status:BookingStatus;revision:number;change_pending:boolean}
type Slot={id:string;starts_at:Date;ends_at:Date;capacity:number;published:boolean;label:string}

export async function createSlot(db:DB,cfg:Config,actor:Actor,store:string,key:string,input:z.infer<typeof slotInput>) {
  return once(db,cfg,actor,'booking.slot',key,{store,input},async()=>{
    await lockDispatch(db,actor.tenant_id)
    const start=new Date(input.starts_at),end=new Date(input.ends_at)
    if (start<=new Date()||end<=start) throw new Fault(422,'INVALID_SLOT','将来の空き枠と有効な終了時刻を指定してください。')
    const overlap=await db.query('SELECT 1 FROM booking_slot WHERE starts_at<$2 AND ends_at>$1 LIMIT 1',[start,end])
    if (overlap.rowCount) throw new Fault(409,'SLOT_OVERLAP','既存の受付枠と時間が重なっています。')
    const id=newId()
    await db.query('INSERT INTO booking_slot VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [id,actor.tenant_id,store,input.label,start,end,input.capacity,input.published])
    await audit(db,actor.tenant_id,store,actor.id,'booking.slot',id)
    return {id}
  })
}

export async function listSlots(db:DB,published=false) {
  return (await db.query(`SELECT s.id,s.label,s.starts_at,s.ends_at,s.capacity,s.published,
    s.capacity-coalesce((SELECT sum(party)::int FROM visit_booking b WHERE b.slot_id=s.id AND b.status='confirmed'),0) AS remaining
    FROM booking_slot s WHERE (NOT $1 OR (published AND starts_at>now())) ORDER BY starts_at LIMIT 150`,[published])).rows
}

export async function listBookings(db:DB,customer?:string) {
  return (await db.query(`SELECT b.id,b.customer_id,b.slot_id,b.party,b.status,b.revision,s.label,s.starts_at,s.ends_at,
    b.business_date::text,b.change_pending,
    c.display_name FROM visit_booking b JOIN booking_slot s ON s.id=b.slot_id
    JOIN customer c ON c.id=b.customer_id
    WHERE ($1::uuid IS NULL OR b.customer_id=$1) ORDER BY s.starts_at DESC,b.id LIMIT 150`,[customer??null])).rows
}

async function slotFor(db:DB,id:string,publicOnly:boolean) {
  const {rows:[slot]}=await db.query<Slot>('SELECT * FROM booking_slot WHERE id=$1 AND (NOT $2 OR published) FOR UPDATE',[id,publicOnly])
  if (!slot) throw missing()
  return slot
}

async function fit(db:DB,slot:Slot,party:number,confirmed:boolean,except?:string) {
  if (+slot.starts_at<=Date.now()) throw new Fault(422,'PAST_SLOT','すでに始まった受付枠は更新できません。')
  if (party>slot.capacity) throw new Fault(409,'CAPACITY','希望人数が受付枠の定員を超えています。')
  if (!confirmed) return
  const {rows:[current]}=await db.query(`SELECT coalesce(sum(party),0)::int AS used FROM visit_booking
    WHERE slot_id=$1 AND ($2::uuid IS NULL OR id<>$2) AND status='confirmed'`,[slot.id,except??null])
  if (current.used+party>slot.capacity) throw new Fault(409,'CAPACITY','希望人数の空きがありません。')
}

export async function requestBooking(db:DB,customer:Customer,slotId:string,party:number,confirm:boolean,publicOnly:boolean) {
  await lockDispatch(db,customer.tenant_id)
  const slot=await slotFor(db,slotId,publicOnly)
  const {rows:[existing]}=await db.query<Booking>(`SELECT * FROM visit_booking
    WHERE customer_id=$1 AND slot_id=$2 AND status IN ('pending','confirmed')`,[customer.id,slotId])
  if (existing) {
    if (existing.party!==party || confirm&&existing.status!=='confirmed') throw conflict()
    return {id:existing.id,revision:existing.revision,status:existing.status}
  }
  await fit(db,slot,party,confirm)
  const id=newId(), status=confirm?'confirmed':'pending'
  await db.query(`INSERT INTO visit_booking(id,tenant_id,store_id,customer_id,slot_id,party,status,business_date)
    SELECT $1,$2,$3,$4,$5,$6,$7,(($8::timestamptz AT TIME ZONE timezone)-(cutoff-time '00:00'))::date
    FROM store WHERE id=$3`,[id,customer.tenant_id,customer.store_id,customer.id,slotId,party,status,slot.starts_at])
  if (confirm) await emitDelivery(db,customer,'booking:'+id+':1','booking_created',new Date(),{id,revision:1})
  return {id,revision:1,status}
}

export async function staffBooking(db:DB,cfg:Config,actor:Actor,store:string,key:string,input:z.infer<typeof bookingInput>) {
  return once(db,cfg,actor,'booking.create',key,{store,input},async()=>{
    const c=await customerById(db,input.customer)
    const result=await requestBooking(db,c,input.slot,input.party,input.confirm,false)
    await audit(db,c.tenant_id,c.store_id,actor.id,'booking.create',result.id,null,{status:result.status})
    return result
  })
}

export async function changeBooking(db:DB,actor:Actor|null,id:string,input:z.infer<typeof bookingChange>,own?:Customer) {
  await lockDispatch(db,own?.tenant_id??actor!.tenant_id)
  const {rows:[previous]}=await db.query<Booking>(`SELECT * FROM visit_booking WHERE id=$1
    AND ($2::uuid IS NULL OR customer_id=$2) FOR UPDATE`,[id,own?.id??null])
  if (!previous) throw missing()
  if (previous.revision!==input.revision) throw conflict()
  const allowed:Record<BookingStatus,BookingStatus[]> = {
    pending:['pending','confirmed','cancelled'],confirmed:['pending','confirmed','cancelled','visited','no_show'],
    cancelled:[],visited:[],no_show:[],
  }
  if (!allowed[previous.status].includes(input.status)) throw conflict()
  const slot=await slotFor(db,input.slot,!!own && input.slot!==previous.slot_id)
  if (own && input.status==='confirmed') throw conflict()
  if (input.status==='pending'||input.status==='confirmed') await fit(db,slot,input.party,input.status==='confirmed',id)
  else if (previous.slot_id!==input.slot || previous.party!==input.party) throw conflict()
  if (['visited','no_show'].includes(input.status) && +slot.starts_at>Date.now()) {
    throw new Fault(422,'TOO_EARLY','予約時刻を過ぎてから来店・不来店を記録してください。')
  }
  if (own && +slot.starts_at<=Date.now()) throw conflict()
  if (previous.slot_id===input.slot && previous.party===input.party && previous.status===input.status) {
    return {id,status:previous.status,revision:previous.revision}
  }
  const version=previous.revision+1
  await db.query(`UPDATE visit_booking b SET slot_id=$2,party=$3,status=$4,revision=$5,updated_at=now(),
    change_pending=CASE WHEN $4='pending' THEN b.status='confirmed' OR b.change_pending ELSE false END,
    business_date=CASE WHEN b.slot_id=$2 THEN b.business_date ELSE
      (($6::timestamptz AT TIME ZONE st.timezone)-(st.cutoff-time '00:00'))::date END
    FROM store st WHERE b.id=$1 AND st.id=b.store_id`,
    [id,input.slot,input.party,input.status,version,slot.starts_at])
  await db.query(`UPDATE enrollment SET ended_at=now(),end_reason='予約の更新により旧版を終了'
    WHERE booking_id=$1 AND ended_at IS NULL`,[id])
  await db.query(`UPDATE automatic_send SET next_at='infinity',reason='予約の更新により旧版を終了'
    WHERE enrollment_id IN (SELECT id FROM enrollment WHERE booking_id=$1)
    AND status IN ('submitting','unknown')`,[id])
  const c=await customerById(db,previous.customer_id)
  const kind=input.status==='visited'?'visit':input.status==='cancelled'?'booking_cancelled':
    input.status==='confirmed'?(previous.status==='pending'&&!previous.change_pending?'booking_created':'booking_changed'):null
  if (kind) await emitDelivery(db,c,'booking:'+id+':'+version,kind,new Date(),{id,revision:version})
  await audit(db,c.tenant_id,c.store_id,actor?.id??null,'booking.update',id,input.reason,
    {previous:previous.status,current:input.status,revision:version})
  return {id,status:input.status,revision:version}
}
