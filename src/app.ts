import { agencyMasterDetails, authenticatePlatformWorkspace, enterPlatformTenant, inviteAgencyMaster, platformSession, platformTenants, platformWorkspace, promoteAgencyMaster } from './platform.js'
import { checkAgencyAccess } from './agency-access.js'
import express, { type Request, type Response, type NextFunction } from 'express'
import { fileURLToPath } from 'node:url'
import type pg from 'pg'
import { z } from 'zod'
import {
  type Actor, type Config, type DB, Fault, audit, conflict, email, newId, once, purpose, revision,
  route, scope, text, tx, uuid,
} from './core.js'
import { accept, authenticate, createInvite, disableStaff, gate, login, logout, memberRole,
  requireAdmin, sessionCookie, storeAccess, storeList } from './auth.js'
import {
  channel, channelCredentials, connectionTestEvent, connectionSchema, consoleSchema, createChannel, evidence, issueTester, LineAPI,
  queueTest, receiveModuleWebhook, receiveWebhook, replaceCredentials, replaceCredentialsSchema, summary, verifyLiff, verifyLiffSchema,
} from './line.js'
import {beginModuleLink, finishModuleLink, moduleConfigured, moduleReturn, moduleReturnPath,
  moduleStart, rememberModuleBot, requireModule} from './line-module.js'
import { changeOnboarding, guideLookup, guidePath, guideSubmission, listOnboarding, markOnboardingRegistered,
  onboardingChange, onboardingDetails, readGuide, submitGuide } from './line-onboarding.js'
import { createScenario, saveScenario, scenarioDetail, scenarioList, scenarioTesters, scenarioTestStatus, queueScenarioTest, transitionScenario, versionDetail } from './scenario.js'
import { lockDispatch, setStop } from './jobs.js'
import { customerFields, consentVersion, updateProfile, profileInput, openCustomerSession, authenticateCustomer,
  customerSessionCookie, setPreferences, customerById, selfPreferenceInput, emitDelivery } from './customer.js'
import { bookingInput, changeBooking, createSlot, listBookings, listSlots, ownBookingChange, ownBookingInput,
  requestBooking, slotInput, bookingChange, staffBooking } from './booking.js'
import { endScope, locationOf, updateAutomation } from './automation.js'
import { changeInterviewVisibility, confirmInterview, interviewAccess, interviewApplicant, interviewCalendar, interviewChange,
  interviewCreate, interviewDates, interviewSlotInput, interviewVisibility, publishInterviewSlot, staffInterviewOverview,
  guestInterviewCreate, interviewHours, saveInterviewHours, startGuestInterviewSession, startInterviewSession,
  updateInterview, recruitmentSubject } from './interviews.js'
import { addBlock, availabilityOverview, beginCalendarLink, blockInput, claimCalendarLink, finishCalendarLink,
  googleCalendarInput, googleCalendarReturn, googleFromEnvironment, removeBlock, unlinkInterviewCalendar } from './interview-availability.js'
import { featureInput, requireFeature, saveStoreFeatures, storeFeatures } from './store-features.js'
import { customerTagInput, listTags, saveCustomerTags, saveTagRule, tagFilter, tagRuleInput,
  listTagSegments, removeTagSegment, saveTagSegment, tagSegmentInput, tagSegmentDelete } from './customer-tags.js'
import { caseInput, formFor, formInput, formQuery, formResponse, listForms, listRecruitment, responses, saveForm, submitForm, updateCase,
  type WorkflowSubject } from './forms.js'
import { saveSource, setSourceStatus, sourceInput, sourceQr, sourceReport, sourceReportInput, sourceStatus } from './sources.js'
import { approvalInput, approveCampaign, campaignInput, campaignOverview, prepareCampaign, stopCampaign } from './campaigns.js'
import { listMenus, menuInput, saveMenus, validateMenus } from './rich-menus.js'
import { interviewNotices, noticeInput, setInterviewNotices, setWaitlist, waitlistInput } from './interview-notices.js'
import { serviceHistory } from './service-delivery.js'
import { changeThread, classifyThread, handoffInput, changeHandoff, inboxClassify, inboxEdit, inboxMessages, inboxOverview, inboxText, writeInbox } from './inbox.js'
import { hostInput, queueGoogleSync, saveHost } from './interview-hosts.js'
import { workflowChecks } from './workflow-checks.js'




const storeFields = {
  name: text(100), address: text(240), business_type: text(120), responsible: text(120),
  timezone: z.string().max(70).refine(value => {
    try { new Intl.DateTimeFormat('ja-JP',{timeZone:value}); return true } catch { return false }
  }),
  cutoff: z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/),
}
const storeSchema = z.strictObject(storeFields)
const storeUpdate = storeSchema.extend({ revision })
const stopSchema = z.strictObject({ revision, stopped: z.boolean(), reason: text(200) })
const eligibilitySchema = z.strictObject({ revision, verified:z.boolean(), reference:text(200) })
const inviteSchema = z.strictObject({ email, role:memberRole.exclude(['admin']), stores:z.array(uuid).min(1).max(100) })
  .refine(data => new Set(data.stores).size === data.stores.length,{path:['stores']})

const cookie = (req:Request,name:string) => req.headers.cookie?.split(';').map(value=>value.trim())
  .find(value=>value.startsWith(name+'='))?.slice(name.length+1)
const credential = (req:Request) => cookie(req,'night_session')
const platformCredential = (req:Request) => cookie(req,'night_platform')
const scoped = (req:Request) => req.params.platformTenant!==undefined
const staffCredential = (req:Request) => scoped(req)?platformCredential(req):credential(req)
const workspacePrefix = (req:Request) => scoped(req)?platformWorkspace+'/'+uuid.parse(req.params.platformTenant):''
const requestActor = (db:DB,req:Request) => scoped(req)
  ? authenticatePlatformWorkspace(db,platformCredential(req),uuid.parse(req.params.platformTenant))
  : authenticate(db,credential(req))
const idOf = (req: Request, key: string) => uuid.parse(req.params[key])
const keyOf = (req: Request) => z.string().regex(/^[a-zA-Z0-9_-]{16,100}$/).parse(req.get('Idempotency-Key'))
const address = (req: Request) => req.socket.remoteAddress ?? 'unknown'
const here = (path: string) => fileURLToPath(new URL(path,import.meta.url))

export function createApp(pool: pg.Pool, cfg: Config, line = new LineAPI(), google = googleFromEnvironment(cfg)) {
  const app = express()
  const api = express.Router({mergeParams:true})
  const workspace = express.Router({mergeParams:true})
  app.disable('x-powered-by')
  app.use((req,res,next) => {
    res.locals.correlation = newId()
    res.set({ 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer',
      'Cache-Control':'no-store', 'X-Frame-Options':'DENY', 'X-Request-ID':res.locals.correlation,
      'Content-Security-Policy':"default-src 'self'; img-src 'self' data:; connect-src 'self' https://*.line.me https://*.line-apps.com https://*.line-scdn.net; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    })
    if (cfg.origin.startsWith('https:')) res.set('Strict-Transport-Security','max-age=31536000')
    next()
  })
  const pageActor = async(req:Request) => {
    if (!staffCredential(req)) return
    try { return await tx(pool,db=>requestActor(db,req)) }
    catch (error) {
      if (error instanceof Fault && (error.status===401 || scoped(req) && error.status===404)) return
      throw error
    }
  }
  const staffPage = async(req:Request,res:Response,next:NextFunction) => {
    const actor=await pageActor(req)
    if (!actor) {
      res.redirect(302,scoped(req)?'/platform/':'/staff/')
    } else if (actor.agency&&/^\/operations(?:\/|$)/i.test(req.path)) {
      res.redirect(302,actor.role==='admin'?'/master/':'/staff/')
    } else next()
  }
  for (const section of ['studio','operations','workflows']) {
    const path='/'+section
    workspace.get(path+'/',staffPage,(req,res)=>{
      if (!req.path.endsWith('/')) res.redirect(302,workspacePrefix(req)+path+'/')
      else res.sendFile(here('../public/'+section+'/index.html'))
    })
    workspace.use(path,staffPage,express.static(here('../public/'+section),{index:false,redirect:false}))
  }
  workspace.get('/interview/staff.html',staffPage,(_req,res)=>res.sendFile(here('../public/interview/staff.html')))
  for (const page of ['google-return.html','guest.html']) {
    app.get('/interview/'+page,(_req,res)=>res.sendFile(here('../public/interview/'+page)))
  }
  const interviewAssets=express.static(here('../public/interview'),{index:false,redirect:false})
  workspace.use('/interview',(req,res,next)=>{
    if (/\.(mjs|css)$/i.test(req.path)) interviewAssets(req,res,next)
    else next()
  })
  app.get(['/api/health','/healthz'],async(_req,res)=>{ await pool.query('SELECT 1');res.json({status:'ok'}) })
  app.get('/',(_req,res)=>{
    if (cfg.publicBookingConnection) res.redirect(302,'/book/'+cfg.publicBookingConnection)
    else res.sendFile(here('../public/home.html'))
  })
  for (const area of ['master','staff']) {
    workspace.get('/'+area+'/',async(req,res)=>{
      res.set('X-Robots-Tag','noindex, nofollow')
      const actor=await pageActor(req)
      if (!actor && scoped(req)) {
        res.redirect(302,'/platform/')
      } else if (!actor) {
        res.sendFile(here('../public/staff-login.html'))
      } else if (area==='master' && actor.role!=='admin') {
        res.redirect(302,'/')
      } else if (area==='staff' && actor.role==='admin') {
        const params=new URLSearchParams()
        for (const name of ['store','line_connected','line_channel']) {
          const value=uuid.safeParse(req.query[name])
          if (value.success) params.set(name,value.data)
        }
        res.redirect(302,workspacePrefix(req)+'/master/'+(params.size?'?'+params:''))
      } else {
        res.sendFile(here(actor.agency?'../public/agency.html':'../public/index.html'))
      }
    })
  }
  app.get('/platform/',async(req,res)=>{
    res.set('X-Robots-Tag','noindex, nofollow')
    const signedIn=await tx(pool,db=>authenticate(db,platformCredential(req),'platform')).then(()=>true,error=>{
      if (error instanceof Fault && error.status===401) return false
      throw error
    })
    res.sendFile(here(signedIn?'../public/platform.html':'../public/staff-login.html'))
  })
  app.get(guidePath,(_req,res)=>res.set('X-Robots-Tag','noindex, nofollow').sendFile(here('../public/line-invite.html')))
  app.get(moduleReturnPath,(_req,res)=>res.sendFile(here('../public/line-module-return.html')))
  app.get('/liff/:connection',(_req,res)=>res.sendFile(here('../public/liff.html')))
  app.get('/book/:connection',(req,res)=>{
    idOf(req,'connection')
    res.sendFile(here('../public/interview/guest.html'))
  })
  const staticAssets=new Set(['style.css','admin.mjs','line-setup.mjs','line-invite.mjs','line-module-return.mjs','platform.mjs','workspace-path.mjs','agency.mjs'])
  const tourAssets=new Set(['tour.mjs','tour.css'])
  app.get('/static/:asset',async(req,res,next)=>{
    const asset=req.params.asset
    if(tourAssets.has(asset)){
      await tx(pool,db=>authenticate(db,platformCredential(req),'platform'))
      res.sendFile(here('../public/'+asset))
    }else if (staticAssets.has(asset)) res.sendFile(here('../public/'+asset))
    else next()
  })
  app.use('/assets',express.static(here('./assets'),{index:false}))
  workspace.use('/api/v1',api)
  app.use(platformWorkspace+'/:platformTenant',workspace)
  app.use(workspace)

  api.post('/webhooks/line/:connection',express.raw({ type:'application/json',limit:'1mb',inflate:false }),
    async (req,res)=>{
      await receiveWebhook(pool,cfg,idOf(req,'connection'),
        Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),req.get('X-Line-Signature') ?? '')
      res.status(200).json({ received:true })
    })
  api.post('/webhooks/line-module',express.raw({type:'application/json',limit:'1mb',inflate:false}),async(req,res)=>{
    await receiveModuleWebhook(pool,cfg,Buffer.isBuffer(req.body)?req.body:Buffer.alloc(0),req.get('X-Line-Signature')??'')
    res.json({received:true})
  })

  api.use((req,_res,next)=>{
    const mutable = !['GET','HEAD','OPTIONS'].includes(req.method)
    if (mutable && req.get('Origin') !== cfg.origin) {
      throw new Fault(403,'INVALID_ORIGIN','操作元を確認できません。')
    }
    if (mutable && !req.is('application/json')) {
      throw new Fault(415,'INVALID_CONTENT_TYPE','JSON形式で送信してください。')
    }
    next()
  })
  api.use(express.json({ limit:'32kb',strict:true }))
  for (const [path,mode] of [
    ['/auth/login','staff'],['/auth/master/login','master'],['/auth/platform/login','platform'],
  ] as const) {
    api.post(path,async(req,res)=>{
      const session=await login(pool,cfg,req.body,address(req),mode)
      res.set('Set-Cookie',sessionCookie(cfg,session,mode==='platform'?'platform':'staff')).json({signed_in:true})
    })
  }
  api.get('/platform/session',async(req,res)=>{
    res.json(await tx(pool,db=>platformSession(db,platformCredential(req))))
  })
  api.get('/platform/tenants',async(req,res)=>{
    res.json(await tx(pool,db=>platformTenants(db,platformCredential(req))))
  })
  api.post('/platform/tenants/:tenant/enter',async(req,res)=>{
    z.strictObject({}).parse(req.body)
    res.json(await tx(pool,db=>enterPlatformTenant(db,platformCredential(req),idOf(req,'tenant'))))
  })
  api.post('/platform/logout',async(req,res)=>{
    await tx(pool,async db=>{
      const session=platformCredential(req)
      if (!session) return
      try { await authenticate(db,session,'platform') }
      catch(error) { if (error instanceof Fault && error.status===401) return; throw error }
      await logout(db,session)
    })
    res.set('Set-Cookie',sessionCookie(cfg,'','platform')).json({signed_out:true})
  })
  api.post('/auth/activate',async (req,res)=>{ res.json(await accept(pool,cfg,req.body,address(req))) })
  api.get('/liff/:connection',async (req,res)=>{
    await gate(pool,cfg,'liff-config:' + address(req),120)
    const data = await tx(pool,async db=>{
      const r = await route(db,idOf(req,'connection'))
      await scope(db,r.tenant_id,r.store_id)
      const c = await channel(db,r.id)
      if (!cfg.external || !c.liff_id || !c.checks.login_published || !c.checks.provider_verified) {
        throw new Fault(409,'LIFF_NOT_READY','LINE内画面の公開準備中です。')
      }
      return { liff_id:c.liff_id,customer:c.purpose!=='recruitment',recruitment:c.purpose!=='customer',purposes:c.purpose==='shared' ? ['customer','recruitment'] : [c.purpose] }
    })
    res.json(data)
  })
  api.post('/auth/line/verify',async (req,res)=>{
    if (!cfg.external) throw new Fault(409,'HTTPS_REQUIRED','公開HTTPS環境で本人確認を行ってください。')
    await gate(pool,cfg,'liff-verify:' + address(req),50)
    res.json(await verifyLiff(pool,cfg,line,verifyLiffSchema.parse(req.body)))
  })

  const localCustomerSession = (req:Request) => req.headers.cookie?.split(';').map(value=>value.trim())
    .find(value=>value.startsWith('night_customer='))?.slice('night_customer='.length)
  api.post('/customer/login',async(req,res)=>{
    await gate(pool,cfg,'customer-login:'+address(req),60)
    const value=await openCustomerSession(pool,cfg,line,req.body)
    res.set('Set-Cookie',customerSessionCookie(cfg,value)).json({signed_in:true})
  })
  api.get('/customer/account',async(req,res)=>{
    res.json(await tx(pool,async db=>{
      const c=await authenticateCustomer(db,localCustomerSession(req))
      const location=await locationOf(db,c.store_id)
      const features=await storeFeatures(db,c.store_id)
      return {revision:c.revision,service_consent:c.service_consent,marketing_consent:c.marketing_consent,
        all_stop:c.all_stop,policy_version:consentVersion,store:location.name,timezone:location.timezone,
        visits_enabled:features.visits_enabled,slots:features.visits_enabled?await listSlots(db,true):[],
        bookings:(await listBookings(db,c.id)).map(({customer_id,display_name,...booking})=>booking)}
    }))
  })
  api.patch('/customer/preferences',async(req,res)=>{
    const p=selfPreferenceInput.parse(req.body)
    res.json(await tx(pool,async db=>{
      const c=await authenticateCustomer(db,localCustomerSession(req))
      await lockDispatch(db,c.tenant_id)
      return setPreferences(db,await customerById(db,c.id),p.preferences,p.revision)
    }))
  })
  api.post('/customer/bookings',async(req,res)=>{
    const p=ownBookingInput.parse(req.body)
    res.status(201).json(await tx(pool,async db=>{
      const c=await authenticateCustomer(db,localCustomerSession(req))
      return requestBooking(db,c,p.slot,p.party,false,true)
    }))
  })
  api.patch('/customer/bookings/:booking',async(req,res)=>{
    const p=ownBookingChange.parse(req.body)
    res.json(await tx(pool,async db=>{
      const c=await authenticateCustomer(db,localCustomerSession(req))
      return changeBooking(db,null,idOf(req,'booking'),{...p,reason:'LIFFの本人操作'},c)
    }))
  })
  const customerSubject=async(db:DB,req:Request):Promise<WorkflowSubject>=>{
    const c=await authenticateCustomer(db,localCustomerSession(req))
    return {tenant_id:c.tenant_id,store_id:c.store_id,channel_id:c.channel_id,purpose:'customer',subject:c.id}
  }

  const interviewCredential=(req:Request)=>req.headers.cookie?.split(';').map(value=>value.trim())
    .find(value=>value.startsWith('night_interview='))?.slice('night_interview='.length)
  api.post('/interview/login',async(req,res)=>{
    await gate(pool,cfg,'interview-login:'+address(req),60)
    res.set('Set-Cookie',await startInterviewSession(pool,cfg,line,req.body)).json({signed_in:true})
  })
  api.get('/interview/calendar',async(req,res)=>{
    const {start}=interviewDates.parse(req.query)
    res.json(await tx(pool,async db=>interviewCalendar(db,await interviewApplicant(db,interviewCredential(req)),google,start)))
  })
  api.post('/interview/bookings',async(req,res)=>{
    const input=interviewCreate.parse(req.body)
    res.status(201).json(await tx(pool,async db=>confirmInterview(db,cfg,await interviewApplicant(db,interviewCredential(req),true),input,google)))
  })
  api.patch('/interview/bookings/:booking',async(req,res)=>{
    const input=interviewChange.parse(req.body)
    res.json(await tx(pool,async db=>updateInterview(db,cfg,await interviewApplicant(db,interviewCredential(req),true),idOf(req,'booking'),input,google)))
  })
  const guestPath='/guest-interview/:connection'
  const guestApplicant=(db:DB,req:Request,write=false)=>{
    const name='night_guest_interview='
    const cookie=req.headers.cookie?.split(';').map(value=>value.trim())
      .find(value=>value.startsWith(name))?.slice(name.length)
    return interviewApplicant(db,cookie,write,idOf(req,'connection'))
  }
  api.post(guestPath+'/session',async(req,res)=>{
    const connection=idOf(req,'connection')
    await gate(pool,cfg,'guest-interview-session:'+connection+':'+address(req),120)
    const cookie=await tx(pool,db=>startGuestInterviewSession(db,cfg,connection))
    res.set('Set-Cookie',cookie).status(201).json({ready:true})
  })
  api.get(guestPath+'/calendar',async(req,res)=>{
    const {start}=interviewDates.parse(req.query)
    await gate(pool,cfg,'guest-interview-calendar:'+idOf(req,'connection')+':'+address(req),180)
    res.json(await tx(pool,async db=>interviewCalendar(db,await guestApplicant(db,req),google,start)))
  })
  api.post(guestPath+'/bookings',async(req,res)=>{
    const {email,...input}=guestInterviewCreate.parse(req.body)
    await gate(pool,cfg,'guest-interview-book:'+idOf(req,'connection')+':'+address(req),60)
    res.status(201).json(await tx(pool,async db=>confirmInterview(db,cfg,await guestApplicant(db,req,true),input,google,email)))
  })
  api.patch(guestPath+'/bookings/:booking',async(req,res)=>{
    const input=interviewChange.parse(req.body)
    await gate(pool,cfg,'guest-interview-change:'+idOf(req,'connection')+':'+address(req),60)
    res.json(await tx(pool,async db=>updateInterview(db,cfg,await guestApplicant(db,req,true),idOf(req,'booking'),input,google)))
  })
  const applicantSubject=async(db:DB,req:Request)=>recruitmentSubject(await interviewApplicant(db,interviewCredential(req)))
  api.get('/interview/notices',async(req,res)=>{
    res.json(await tx(pool,async db=>interviewNotices(db,await applicantSubject(db,req))))
  })
  api.put('/interview/notices',async(req,res)=>{
    const {enabled}=noticeInput.parse(req.body)
    res.json(await tx(pool,async db=>setInterviewNotices(db,cfg,await applicantSubject(db,req),enabled)))
  })
  api.put('/interview/waitlist',async(req,res)=>{
    const data=waitlistInput.parse(req.body)
    res.json(await tx(pool,async db=>setWaitlist(db,await applicantSubject(db,req),data)))
  })
  api.delete('/interview/waitlist',async(req,res)=>{
    res.json(await tx(pool,async db=>setWaitlist(db,await applicantSubject(db,req),null)))
  })
  for(const [path,subject] of [['/customer/form',customerSubject],['/interview/form',applicantSubject]] as const){
    api.get(path,async(req,res)=>{
      const {form}=formQuery.parse(req.query)
      res.json(await tx(pool,async db=>formFor(db,await subject(db,req),form)))
    })
    api.post(path,async(req,res)=>{
      const data=formResponse.parse(req.body)
      res.status(201).json(await tx(pool,async db=>submitForm(db,cfg,await subject(db,req),data)))
    })
  }

  type Action = (db: DB,actor: Actor,req: Request) => Promise<unknown>
  const staff = (action: Action, status=200) => async (req: Request,res: Response) => {
    const data = await tx(pool,async db=>{
      const actor=await requestActor(db,req)
      checkAgencyAccess(actor,req)
      return action(db,actor,req)
    })
    res.status(status).json(data)
  }
  const inStore = (action: Action,manage = true,status=200) => staff(async (db,actor,req)=>{
    await storeAccess(db,actor,idOf(req,'store'),manage)
    return action(db,actor,req)
  },status)
  const withChannel = (action: (db:DB,actor:Actor,req:Request,c:Awaited<ReturnType<typeof channel>>)=>Promise<unknown>,
    status=200)=>inStore(async (db,actor,req)=>action(db,actor,req,await channel(db,idOf(req,'connection'))),true,status)

  const interviewStaff=(action:Action,status=200)=>staff(async(db,actor,req)=>{
    await interviewAccess(db,actor,idOf(req,'store'))
    return action(db,actor,req)
  },status)
  const workPurpose=(req:Request)=>purpose.parse(req.params.purpose)
  const workflowAccess=(db:DB,actor:Actor,store:string,use:WorkflowSubject['purpose'])=>
    use==='customer'?storeAccess(db,actor,store,true):interviewAccess(db,actor,store)
  const workflowStaff=(action:Action,status=200)=>staff(async(db,actor,req)=>{
    await workflowAccess(db,actor,idOf(req,'store'),workPurpose(req))
    return action(db,actor,req)
  },status)
  const workflow='/stores/:store/workflows/:purpose'
  api.get(workflow+'/settings',workflowStaff((db,_actor,req)=>storeFeatures(db,idOf(req,'store'))))
  api.get(workflow+'/checks',workflowStaff((db,_actor,req)=>workflowChecks(db,cfg,idOf(req,'store'),workPurpose(req),google.configured)))
  api.get(workflow+'/delivery',workflowStaff((db,_actor,req)=>serviceHistory(db,workPurpose(req))))
  api.get(workflow+'/inbox',workflowStaff((db,actor,req)=>inboxOverview(db,idOf(req,'store'),workPurpose(req),actor.platform?actor.id:undefined)))
  api.get(workflow+'/inbox/:thread',workflowStaff((db,_actor,req)=>inboxMessages(db,cfg,idOf(req,'store'),workPurpose(req),idOf(req,'thread'))))
  api.patch(workflow+'/inbox/:thread',workflowStaff((db,actor,req)=>
    changeThread(db,actor,idOf(req,'store'),workPurpose(req),idOf(req,'thread'),inboxEdit.parse(req.body))))
  api.patch(workflow+'/inbox/:thread/handoff',workflowStaff((db,actor,req)=>
    changeHandoff(db,actor,idOf(req,'store'),workPurpose(req),idOf(req,'thread'),handoffInput.parse(req.body))))
  api.post(workflow+'/inbox/:thread',workflowStaff((db,actor,req)=>
    writeInbox(db,cfg,actor,idOf(req,'store'),workPurpose(req),idOf(req,'thread'),keyOf(req),inboxText.parse(req.body)),201))
  const intake='/stores/:store/intake'
  api.get(intake,inStore((db,actor,req)=>inboxOverview(db,idOf(req,'store'),'unclassified',actor.platform?actor.id:undefined)))
  api.get(intake+'/:thread',inStore((db,_actor,req)=>inboxMessages(db,cfg,idOf(req,'store'),'unclassified',idOf(req,'thread'))))
  api.patch(intake+'/:thread',inStore((db,actor,req)=>
    classifyThread(db,actor,idOf(req,'store'),idOf(req,'thread'),inboxClassify.parse(req.body))))
  api.patch(intake+'/:thread/handoff',inStore((db,actor,req)=>
    changeHandoff(db,actor,idOf(req,'store'),'unclassified',idOf(req,'thread'),handoffInput.parse(req.body))))
  api.get(workflow+'/forms',workflowStaff((db,_actor,req)=>listForms(db,idOf(req,'store'),workPurpose(req))))
  api.put(workflow+'/forms',workflowStaff((db,actor,req)=>saveForm(db,cfg,actor,idOf(req,'store'),workPurpose(req),keyOf(req),formInput.parse(req.body))))
  api.get(workflow+'/responses',workflowStaff((db,_actor,req)=>responses(db,cfg,idOf(req,'store'),workPurpose(req))))
  api.get(workflow+'/sources',workflowStaff((db,_actor,req)=>
    sourceReport(db,idOf(req,'store'),workPurpose(req),sourceReportInput.parse(req.query).days)))
  api.post(workflow+'/sources',workflowStaff((db,actor,req)=>
    saveSource(db,actor,idOf(req,'store'),workPurpose(req),sourceInput.parse(req.body)),201))
  api.patch(workflow+'/sources/:source',workflowStaff((db,actor,req)=>
    setSourceStatus(db,actor,idOf(req,'store'),workPurpose(req),idOf(req,'source'),sourceStatus.parse(req.body).active)))
  api.get(workflow+'/sources/:source/qr',workflowStaff((db,_actor,req)=>
    sourceQr(db,idOf(req,'store'),workPurpose(req),idOf(req,'source'))))
  api.get(workflow+'/rich-menus',workflowStaff((db,_actor,req)=>listMenus(db,idOf(req,'store'),workPurpose(req))))
  api.put(workflow+'/rich-menus',async(req,res)=>{
    const store=idOf(req,'store'),use=workPurpose(req),data=menuInput.parse(req.body)
    await gate(pool,cfg,'menu-verify:'+address(req),30)
    const authorized=async(db:DB)=>{
      const actor=await requestActor(db,req)
      checkAgencyAccess(actor,req)
      await workflowAccess(db,actor,store,use)
      return actor
    }
    const generation=await tx(pool,async db=>{
      await authorized(db)
      return validateMenus(db,cfg,line,store,use,data)
    })
    res.json(await tx(pool,async db=>saveMenus(db,await authorized(db),store,use,data,generation)))
  })
  api.get('/stores/:store/recruitment',interviewStaff((db,_actor,req)=>listRecruitment(db,cfg,idOf(req,'store'))))
  api.patch('/stores/:store/recruitment/:case',interviewStaff((db,actor,req)=>
    updateCase(db,actor,idOf(req,'store'),idOf(req,'case'),caseInput.parse(req.body))))
  const campaigns='/stores/:store/campaigns'
  api.get(campaigns,inStore((db,_actor,req)=>campaignOverview(db,cfg,idOf(req,'store'))))
  api.post(campaigns,inStore((db,actor,req)=>prepareCampaign(db,cfg,actor,idOf(req,'store'),keyOf(req),campaignInput.parse(req.body)),true,201))
  api.post(campaigns+'/:campaign/approve',inStore((db,actor,req)=>
    approveCampaign(db,cfg,actor,idOf(req,'store'),idOf(req,'campaign'),approvalInput.parse(req.body))))
  api.post(campaigns+'/:campaign/stop',inStore((db,actor,req)=>stopCampaign(db,actor,idOf(req,'store'),idOf(req,'campaign'))))
  api.get('/stores/:store/interviews',interviewStaff((db,_actor,req)=>staffInterviewOverview(db,idOf(req,'store'),cfg)))
  api.patch('/stores/:store/interviews/hours',interviewStaff((db,actor,req)=>
    saveInterviewHours(db,actor,idOf(req,'store'),interviewHours.parse(req.body))))
  const availability='/stores/:store/interviews/availability'
  api.get(availability,interviewStaff((db,_actor,req)=>availabilityOverview(db,idOf(req,'store'),google)))
  api.post(availability+'/blocks',interviewStaff((db,actor,req)=>
    addBlock(db,cfg,actor,idOf(req,'store'),keyOf(req),blockInput.parse(req.body)),201))
  api.delete(availability+'/blocks/:block',interviewStaff((db,actor,req)=>
    removeBlock(db,actor,idOf(req,'store'),idOf(req,'block'))))
  api.post(availability+'/google',interviewStaff((db,actor,req)=>
    beginCalendarLink(db,actor,idOf(req,'store'),googleCalendarInput.parse(req.body).calendar_id,google)))
  api.post(availability+'/google/complete',async(req,res)=>{
    const data=googleCalendarReturn.parse(req.body),store=idOf(req,'store')
    const authorized=async(db:DB)=>{
      const actor=await requestActor(db,req)
      checkAgencyAccess(actor,req)
      await interviewAccess(db,actor,store)
      return actor
    }
    const pending=await tx(pool,async db=>claimCalendarLink(db,await authorized(db),store,data.state))
    const refresh=await google.exchange(data.code,pending.verifier,pending.calendar_id,pending.write_requested)
    await tx(pool,async db=>{
      await finishCalendarLink(db,cfg,await authorized(db),store,data.state,refresh)
      if(pending.write_requested)await queueGoogleSync(db,store)
    })
    res.json({connected:true})
  })
  api.delete(availability+'/google',interviewStaff((db,actor,req)=>
    unlinkInterviewCalendar(db,actor,idOf(req,'store'))))
  api.post('/stores/:store/interviews/slots',interviewStaff((db,actor,req)=>
    publishInterviewSlot(db,cfg,actor,idOf(req,'store'),keyOf(req),interviewSlotInput.parse(req.body)),201))
  api.patch('/stores/:store/interviews/slots/:slot',interviewStaff((db,actor,req)=>
    changeInterviewVisibility(db,actor,idOf(req,'store'),idOf(req,'slot'),interviewVisibility.parse(req.body))))
  api.put('/stores/:store/interviews/hosts',interviewStaff((db,actor,req)=>
    saveHost(db,actor,idOf(req,'store'),hostInput.parse(req.body))))
  api.post('/stores/:store/interviews/calendar-sync',interviewStaff(async(db,actor,req)=>{
    const store=idOf(req,'store')
    await lockDispatch(db,actor.tenant_id)
    await requireFeature(db,store,'google_write_enabled')
    await queueGoogleSync(db,store)
    return {queued:true}
  }))

  api.post('/auth/logout',async (req,res)=>{
    if (credential(req)) {
      await tx(pool,async db=>{
        try { await authenticate(db,credential(req)) }
        catch(error) { if (error instanceof Fault && error.status===401) return; throw error }
        await logout(db,credential(req)!)
      })
    }
    res.set('Set-Cookie',sessionCookie(cfg)).json({ signed_out:true })
  })
  api.get('/line-onboarding',staff(async(db,actor)=>{
    requireAdmin(actor)
    return listOnboarding(db,actor)
  }))
  const onboarding='/stores/:store/line-onboarding'
  api.get(onboarding,inStore(async(db,actor,req)=>{
    requireAdmin(actor)
    return onboardingDetails(db,cfg,idOf(req,'store'))
  }))
  api.patch(onboarding,inStore(async(db,actor,req)=>{
    requireAdmin(actor)
    return changeOnboarding(db,cfg,actor,idOf(req,'store'),onboardingChange.parse(req.body))
  }))
  api.post('/line-onboarding/guide',async(req,res)=>{
    const {token}=guideLookup.parse(req.body)
    res.json(await tx(pool,db=>readGuide(db,token)))
  })
  api.post('/line-onboarding/guide/submit',async(req,res)=>{
    const {token,invitation}=guideSubmission.parse(req.body)
    res.json(await tx(pool,db=>submitGuide(db,cfg,token,invitation)))
  })
  api.get('/session',staff(async (db,actor)=>{
    const { rows:[tenant] } = await db.query(`SELECT id,slug,legal_name,stopped,revision FROM tenant WHERE id=$1`,[actor.tenant_id])
    return { actor:{ id:actor.id,email:actor.email,role:actor.role,platform:actor.platform===true,agency:actor.agency===true }, tenant, stores:await storeList(db,actor) }
  }))
  api.get('/agency-master',staff((db,actor)=>agencyMasterDetails(db,actor)))
  api.post('/agency-master/invite',staff((db,actor,req)=>{
    const {address}=z.strictObject({address:email}).parse(req.body)
    return inviteAgencyMaster(db,cfg,actor,address,keyOf(req))
  },201))
  api.post('/agency-master/promote',staff((db,actor,req)=>{
    const {pending}=z.strictObject({pending:uuid}).parse(req.body)
    return promoteAgencyMaster(db,actor,pending)
  }))
  api.post('/stores',staff(async (db,actor,req)=>{
    requireAdmin(actor)
    const data = storeSchema.parse(req.body)
    return once(db,cfg,actor,'store.create',keyOf(req),data,async ()=>{
      await scope(db,actor.tenant_id,undefined,true)
      const id = newId()
      await db.query(`INSERT INTO store(id,tenant_id,name,address,business_type,responsible,timezone,cutoff)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[id,actor.tenant_id,data.name,data.address,
        data.business_type,data.responsible,data.timezone,data.cutoff])
      await audit(db,actor.tenant_id,id,actor.id,'store.create',id)
      return { id }
    })
  },201))
  api.patch('/stores/:store',inStore(async (db,actor,req)=>{
    const id = idOf(req,'store')
    const data = storeUpdate.parse(req.body)
    await lockDispatch(db,actor.tenant_id)
    const updated = await db.query(`UPDATE store SET name=$2,address=$3,business_type=$4,responsible=$5,
      timezone=$6,cutoff=$7,revision=revision+1,
      auto_enabled=CASE WHEN address=$3 AND business_type=$4 THEN auto_enabled ELSE false END,eligible_at=CASE WHEN address=$3 AND business_type=$4
      THEN eligible_at ELSE NULL END,eligibility_reference=CASE WHEN address=$3 AND business_type=$4
      THEN eligibility_reference ELSE NULL END WHERE id=$1 AND revision=$8 RETURNING revision`,
    [id,data.name,data.address,data.business_type,data.responsible,data.timezone,data.cutoff,data.revision])
    if (!updated.rowCount) throw conflict()
    await audit(db,actor.tenant_id,id,actor.id,'store.update',id)
    return updated.rows[0]
  }))
  api.patch('/stores/:store/eligibility',inStore(async (db,actor,req)=>{
    requireAdmin(actor)
    const id = idOf(req,'store')
    const data = eligibilitySchema.parse(req.body)
    await lockDispatch(db,actor.tenant_id)
    const updated = await db.query(`UPDATE store SET eligible_at=CASE WHEN $2 THEN now() ELSE NULL END,
      auto_enabled=CASE WHEN $2 THEN auto_enabled ELSE false END,
      eligibility_reference=$3,revision=revision+1 WHERE id=$1 AND revision=$4 RETURNING revision`,
      [id,data.verified,data.reference,data.revision])
    if (!updated.rowCount) throw conflict()
    if (!data.verified) await endScope(db,'store_id=$1',[id],'店舗の適格性確認を解除')
    await audit(db,actor.tenant_id,id,actor.id,'store.eligibility',id,data.reference,{verified:data.verified})
    return updated.rows[0]
  }))
  api.get('/staff',staff(async(db,actor)=>{
    requireAdmin(actor)
    await scope(db,actor.tenant_id,undefined,true)
    const { rows } = await db.query(`SELECT f.id,f.email,f.role,f.disabled_at,
      f.password_hash IS NOT NULL AS activated, (f.role='admin' OR f.agency_staff) AS agency_access,
      coalesce((SELECT array_agg(g.store_id ORDER BY g.store_id) FROM store_grant g WHERE g.staff_id=f.id),'{}') AS stores
      FROM staff f WHERE NOT f.platform_actor ORDER BY f.email`)
    return rows
  }))
  api.post('/staff/invites',staff(async(db,actor,req)=>{
    requireAdmin(actor)
    const data = inviteSchema.parse(req.body)
    return once(db,cfg,actor,'staff.invite',keyOf(req),data,
      ()=>createInvite(db,cfg,actor.tenant_id,data,actor.id))
  },201))
  api.post('/staff/:staff/disable',staff(async(db,actor,req)=>{
    const data = z.strictObject({ reason:text(200) }).parse(req.body)
    await disableStaff(db,actor,idOf(req,'staff'),data.reason)
    return { disabled:true }
  }))

  api.get('/stores/:store/staff-options',inStore(async(db)=>{
    const {rows}=await db.query(`SELECT f.id,f.email FROM staff f WHERE f.disabled_at IS NULL AND f.password_hash IS NOT NULL
      AND (f.role='admin' OR (f.agency_staff AND EXISTS(SELECT 1 FROM store_grant g WHERE g.staff_id=f.id AND g.store_id=scope_store())))
      ORDER BY f.email LIMIT 150`)
    return rows
  }))
  api.get('/stores/:store/features',inStore((db,_actor,req)=>storeFeatures(db,idOf(req,'store'))))
  api.patch('/stores/:store/features',inStore((db,actor,req)=>{
    requireAdmin(actor)
    return saveStoreFeatures(db,actor,idOf(req,'store'),featureInput.parse(req.body))
  }))
  api.get('/stores/:store/tags',inStore(async(db,_actor,req)=>{
    await requireFeature(db,idOf(req,'store'),'tags_enabled')
    return listTags(db)
  }))
  api.put('/stores/:store/tags',inStore((db,actor,req)=>
    saveTagRule(db,actor,idOf(req,'store'),tagRuleInput.parse(req.body))))
  api.get('/stores/:store/tag-filters',inStore(async(db,_actor,req)=>{
    await requireFeature(db,idOf(req,'store'),'tags_enabled')
    return listTagSegments(db)
  }))
  api.put('/stores/:store/tag-filters',inStore((db,actor,req)=>
    saveTagSegment(db,actor,idOf(req,'store'),tagSegmentInput.parse(req.body))))
  api.delete('/stores/:store/tag-filters',inStore((db,actor,req)=>
    removeTagSegment(db,actor,idOf(req,'store'),tagSegmentDelete.parse(req.body).name)))
  api.get('/stores/:store/customers',inStore(async(db,_actor,req)=>{
    const filter=tagFilter.parse(req.query)
    const tags=typeof filter.tag==='string'?[filter.tag]:filter.tag??[]
    if (tags.length) await requireFeature(db,idOf(req,'store'),'tags_enabled')
    const {rows}=await db.query(`SELECT c.*,ch.label AS channel_label FROM (
      SELECT ${customerFields} FROM customer
      WHERE cardinality($1::text[])=0 OR CASE WHEN $2='all' THEN tags @> $1 ELSE tags && $1 END
      ORDER BY updated_at DESC,id LIMIT 150) c
      JOIN channel ch ON ch.id=c.channel_id`,[tags,filter.match])
    return rows
  }))
  api.patch('/stores/:store/customers/:customer',inStore(async(db,actor,req)=>
    updateProfile(db,actor,idOf(req,'customer'),profileInput.parse(req.body))))
  api.patch('/stores/:store/customers/:customer/tags',inStore((db,actor,req)=>
    saveCustomerTags(db,actor,idOf(req,'store'),idOf(req,'customer'),customerTagInput.parse(req.body))))
  api.post('/stores/:store/customers/:customer/enroll',inStore(async(db,actor,req)=>{
    const reason=z.strictObject({reason:text(200)}).parse(req.body).reason
    const c=await customerById(db,idOf(req,'customer'))
    return once(db,cfg,actor,'customer.manual-enroll',keyOf(req),{id:c.id,reason},async()=>{
      await lockDispatch(db,actor.tenant_id)
      const key=newId()
      await emitDelivery(db,await customerById(db,c.id),'manual:'+key,'manual')
      await audit(db,c.tenant_id,c.store_id,actor.id,'customer.manual_enroll',c.id,reason,{key})
      return {registered:true}
    })
  },true,202))
  api.get('/stores/:store/slots',inStore(db=>listSlots(db)))
  api.post('/stores/:store/slots',inStore((db,actor,req)=>
    createSlot(db,cfg,actor,idOf(req,'store'),keyOf(req),slotInput.parse(req.body)),true,201))
  api.get('/stores/:store/bookings',inStore(db=>listBookings(db)))
  api.post('/stores/:store/bookings',inStore((db,actor,req)=>
    staffBooking(db,cfg,actor,idOf(req,'store'),keyOf(req),bookingInput.parse(req.body)),true,201))
  api.patch('/stores/:store/bookings/:booking',inStore((db,actor,req)=>
    changeBooking(db,actor,idOf(req,'booking'),bookingChange.parse(req.body))))
  api.get('/stores/:store/automation',inStore(async(db,_actor,req)=>{
    const settings=await locationOf(db,idOf(req,'store'))
    const {rows:jobs}=await db.query(`SELECT j.id,j.status,j.reason,j.line_request_id,j.first_attempt_at,
      j.node_id,j.category FROM automatic_send j ORDER BY first_attempt_at DESC LIMIT 60`)
    const {rows:notes}=await db.query(`SELECT kind,node_id,detail,occurred_at FROM delivery_note ORDER BY id DESC LIMIT 60`)
    return {...settings,process_enabled:cfg.automation===true&&cfg.external,jobs,notes}
  }))
  api.patch('/stores/:store/automation',inStore(async(db,actor,req)=>{
    requireAdmin(actor)
    const settings=z.strictObject({revision,enabled:z.boolean(),contract:z.boolean(),
      monthly_limit:z.int().min(1).max(1000000),reason:text(200)}).parse(req.body)
    return updateAutomation(db,cfg,actor,idOf(req,'store'),settings)
  }))

  const scenarios = '/stores/:store/scenarios'
  const scenario = scenarios+'/:scenario'
  const scenarioContext = (db:DB,actor:Actor,req:Request) => ({db,actor,store:idOf(req,'store')})
  api.get(scenarios,inStore((db,actor,req)=>scenarioList(scenarioContext(db,actor,req))))
  api.post(scenarios,inStore((db,actor,req)=>createScenario(scenarioContext(db,actor,req),cfg,req,keyOf(req)),true,201))
  api.get(scenario,inStore((db,actor,req)=>scenarioDetail(scenarioContext(db,actor,req),idOf(req,'scenario'))))
  api.patch(scenario,inStore((db,actor,req)=>saveScenario(scenarioContext(db,actor,req),idOf(req,'scenario'),req.body)))
  api.get(scenario+'/versions/:version',inStore((db,actor,req)=>versionDetail(scenarioContext(db,actor,req),
    idOf(req,'scenario'),z.coerce.number().int().positive().parse(req.params.version))))
  api.post(scenario+'/transition',inStore((db,actor,req)=>transitionScenario(scenarioContext(db,actor,req),idOf(req,'scenario'),req.body)))

  api.get(scenario+'/testers',inStore((db,actor,req)=>scenarioTesters(scenarioContext(db,actor,req),idOf(req,'scenario'))))
  api.get(scenario+'/test-sends',inStore((db,actor,req)=>scenarioTestStatus(scenarioContext(db,actor,req),idOf(req,'scenario'))))
  api.post(scenario+'/test-sends',inStore((db,actor,req)=>queueScenarioTest(scenarioContext(db,actor,req),cfg,
    idOf(req,'scenario'),keyOf(req),req.body),true,202))

  const channels = '/stores/:store/connections'
  const connection = channels + '/:connection'
  const moduleLink = '/stores/:store/line-module'
  api.get(moduleLink,inStore(async()=>({configured:moduleConfigured(cfg)})))
  api.post(moduleLink,inStore((db,actor,req)=>beginModuleLink(db,cfg,actor,idOf(req,'store'),
    staffCredential(req)!,moduleStart.parse(req.body).purpose)))
  api.post(moduleLink+'/complete',async(req,res)=>{
    const data=moduleReturn.parse(req.body),store=idOf(req,'store'),session=staffCredential(req)
    const authorized=async(db:DB)=>{
      const actor=await requestActor(db,req)
      checkAgencyAccess(actor,req)
      await storeAccess(db,actor,store,true)
      return actor
    }
    const pending=await tx(pool,async db=>rememberModuleBot(db,line.modules,cfg,await authorized(db),store,session!,data))
    if (pending.connection_id) {
      res.json({id:pending.connection_id})
      return
    }
    const bot=await line.modules.bot(requireModule(cfg),pending.bot_user_id!)
    res.json(await tx(pool,async db=>{
      const linked=await finishModuleLink(db,cfg,await authorized(db),store,session!,data.state,bot)
      await markOnboardingRegistered(db,store,linked.id)
      return linked
    }))
  })
  api.get(channels,inStore(async(db,_actor,req)=>{
    const { rows } = await db.query<{id:string}>('SELECT id FROM channel WHERE store_id=$1 ORDER BY label',[idOf(req,'store')])
    return Promise.all(rows.map(async row=>summary(db,cfg,await channel(db,row.id))))
  }))
  api.post(channels,inStore(async(db,actor,req)=>{
    const data = connectionSchema.parse(req.body)
    const store = idOf(req,'store')
    return once(db,cfg,actor,'line.register',keyOf(req),{store,data},async()=>{
      const botUserId = data.bot_user_id ?? await line.botIdForChannel(data.messaging_id,data)
      if (!botUserId) throw new Fault(422,'LINE_CHANNEL_TOKEN','Messaging APIのチャネルIDと、同じチャネルで発行したアクセストークンを確認してください。')
      const created=await createChannel(db,cfg,actor,store,{...data,bot_user_id:botUserId})
      await markOnboardingRegistered(db,store,created.id)
      return created
    })
  },true,201))
  api.patch(connection+'/credentials',withChannel(async(db,actor,req,c)=>{
    await lockDispatch(db,actor.tenant_id)
    await replaceCredentials(db,cfg,actor,c,replaceCredentialsSchema.parse(req.body))
    return summary(db,cfg,await channel(db,c.id))
  }))
  api.patch(connection+'/console',withChannel(async(db,actor,req,c)=>{
    const { revision,reason,...checks } = consoleSchema.parse(req.body)
    if (c.module_channel_id) throw new Fault(409,'LINE_MODULE_MANAGED','かんたん連携では設定情報を自動で確認します。')
    await lockDispatch(db,actor.tenant_id)
    if (checks.delivery_confirmed && !(await evidence(db,c)).send_accepted) {
      throw new Fault(409,'SEND_NOT_ACCEPTED','LINEがテスト送信を受け付けた後に、実機の受信を記録してください。')
    }
    const changed = await db.query(`UPDATE channel SET checks=checks || $2::jsonb,revision=revision+1
      WHERE id=$1 AND revision=$3 RETURNING id`,[c.id,JSON.stringify(checks),revision])
    if (!changed.rowCount) throw conflict()
    await audit(db,c.tenant_id,c.store_id,actor.id,'line.console',c.id,reason,checks)
    return summary(db,cfg,await channel(db,c.id))
  }))
  for (const item of ['token','webhook'] as const) {
    api.post(connection+'/check-'+item,async(req,res)=>{
      const required = z.strictObject({ revision }).parse(req.body)
      const read = async (db:DB) => {
        const actor = await requestActor(db,req)
        checkAgencyAccess(actor,req)
        await storeAccess(db,actor,idOf(req,'store'),true)
        const c = await channel(db,idOf(req,'connection'))
        if (c.module_channel_id && item==='webhook') throw new Fault(409,'LINE_MODULE_MANAGED','公式LINEへのテストメッセージで受信を確認してください。')
        if (c.revision !== required.revision) throw conflict()
        return { actor,c }
      }
      const { actor,c } = await tx(pool,read)
      if (!cfg.external) throw new Fault(409,'HTTPS_REQUIRED','公開HTTPS環境でLINE接続を確認してください。')
      await gate(pool,cfg,'line-check:'+item+':'+c.id,5)
      const cred = channelCredentials(cfg,c)
      const passed = item==='token' ? await line.checkToken(c,cred)
        : c.checks.token_verified && await line.checkWebhook(cred,cfg.origin+'/api/v1/webhooks/line/'+c.id)
      const response = await tx(pool,async db=>{
        await read(db)
        await lockDispatch(db,actor.tenant_id)
        const checks = { [item+'_verified']: !!passed, ...(item==='token' && !passed ? {webhook_verified:false} : {}) }
        const updated = await db.query(`UPDATE channel SET checks=checks || $2::jsonb,revision=revision+1
          WHERE id=$1 AND revision=$3 RETURNING id`,[c.id,JSON.stringify(checks),c.revision])
        if (!updated.rowCount) throw conflict()
        await audit(db,c.tenant_id,c.store_id,actor.id,'line.check_'+item,c.id,null,checks)
        return summary(db,cfg,await channel(db,c.id))
      })
      res.json(response)
    })
  }
  api.post(connection+'/module-delivery',withChannel(async(db,actor,req,c)=>{
    if (!c.module_channel_id) throw conflict()
    const data=z.strictObject({revision}).parse(req.body)
    await lockDispatch(db,actor.tenant_id)
    const current=await channel(db,c.id)
    if (current.revision!==data.revision) throw conflict()
    if (current.module_status!=='active' || !current.checks.token_verified || !current.checks.webhook_verified ||
      !(await evidence(db,current)).send_accepted) {
      throw new Fault(409,'SEND_NOT_ACCEPTED','端末へテストメッセージが届いてから確認してください。')
    }
    await db.query(`UPDATE channel SET checks=checks || '{"delivery_confirmed":true}'::jsonb,revision=revision+1 WHERE id=$1`,[c.id])
    await audit(db,c.tenant_id,c.store_id,actor.id,'line.module_delivery_confirmed',c.id)
    return summary(db,cfg,await channel(db,c.id))
  }))
  api.get(connection+'/tests',withChannel(async(db,_actor,_req,c)=>{
    const { rows } = await db.query(`SELECT t.id,t.purpose,t.verified_at,t.expires_at,
      j.status AS send_status,j.line_request_id,
      EXISTS(SELECT 1 FROM webhook_event e WHERE ${connectionTestEvent}) AS received
      FROM tester t LEFT JOIN test_send j ON j.tester_id=t.id AND j.scenario_id IS NULL
      WHERE t.channel_id=$1 AND t.generation=$2 ORDER BY t.expires_at DESC LIMIT 50`,[c.id,c.generation])
    return rows
  }))
  api.post(connection+'/tests',withChannel(async(db,actor,req,c)=>{
    const usage = z.strictObject({purpose}).parse(req.body).purpose
    return once(db,cfg,actor,'line.tester_invite',keyOf(req),{connection:c.id,generation:c.generation,usage},
      ()=>issueTester(db,actor,c,usage))
  },201))
  api.post(connection+'/tests/:tester/send',withChannel(async(db,actor,req,c)=>{
    z.strictObject({}).parse(req.body)
    if (!cfg.external) throw new Fault(409,'HTTPS_REQUIRED','公開HTTPS環境でテスト送信してください。')
    await lockDispatch(db,actor.tenant_id)
    const current = await channel(db,c.id)
    const { rows:[state] } = await db.query(`SELECT s.stopped OR t.stopped AS stopped FROM store s
      JOIN tenant t ON s.tenant_id=t.id WHERE s.id=$1`,[c.store_id])
    if (current.stopped || state.stopped) throw new Fault(409,'DELIVERY_STOPPED','配信が停止中です。')
    return queueTest(db,actor,current,idOf(req,'tester'),keyOf(req))
  },202))
  api.patch('/tenant/stop',staff(async(db,actor,req)=>{
    requireAdmin(actor)
    const data = stopSchema.parse(req.body)
    await scope(db,actor.tenant_id,undefined,true)
    return setStop(db,actor,'tenant',actor.tenant_id,data.stopped,data.revision,data.reason,null)
  }))
  api.patch('/stores/:store/stop',inStore(async(db,actor,req)=>{
    const id = idOf(req,'store')
    const data = stopSchema.parse(req.body)
    return setStop(db,actor,'store',id,data.stopped,data.revision,data.reason,id)
  }))
  api.patch(connection+'/stop',withChannel(async(db,actor,req,c)=>{
    const data = stopSchema.parse(req.body)
    return setStop(db,actor,'channel',c.id,data.stopped,data.revision,data.reason,c.store_id)
  }))
  api.get('/stores/:store/audit',inStore(async(db,actor)=>{
    const { rows } = await db.query(`SELECT a.id,a.operation,a.object_id,a.reason,
      CASE WHEN $1 THEN a.details ELSE a.details-'platform_staff_id' END AS details,a.occurred_at,
      CASE WHEN f.platform_actor THEN '全体管理者' ELSE f.email END AS actor FROM audit a LEFT JOIN staff f ON f.id=a.actor_id
      ORDER BY a.id DESC LIMIT 100`,[actor.platform===true])
    return rows
  }))
  api.get('/tenant/audit',staff(async(db,actor)=>{
    requireAdmin(actor)
    await scope(db,actor.tenant_id,undefined,true)
    const { rows } = await db.query(`SELECT a.id,a.operation,a.object_id,a.reason,
      CASE WHEN $1 THEN a.details ELSE a.details-'platform_staff_id' END AS details,a.occurred_at,
      CASE WHEN f.platform_actor THEN '全体管理者' ELSE f.email END AS actor FROM audit a LEFT JOIN staff f ON f.id=a.actor_id
      WHERE a.store_id IS NULL ORDER BY a.id DESC LIMIT 100`,[actor.platform===true])
    return rows
  }))

  app.use((_req,_res,next)=>next(new Fault(404,'NOT_FOUND','対象が見つかりません。')))
  app.use((error: unknown,_req: Request,res: Response,_next: NextFunction)=>{
    let fault: Fault
    let fields: Record<string,string> = {}
    if (error instanceof Fault) fault = error
    else if (error instanceof z.ZodError) {
      fault = new Fault(400,'INVALID_INPUT','入力内容を確認してください。')
      fields = Object.fromEntries(error.issues.map(issue=>[issue.path.join('.') || 'body',
        '値の形式または必須項目を確認してください。']))
    } else {
      const code = (error as { code?:string })?.code
      const status = (error as { status?:number })?.status
      if (code === '23505') fault = conflict()
      else if (status === 413) fault = new Fault(413,'TOO_LARGE','送信された内容が大きすぎます。')
      else if (status === 415) fault = new Fault(415,'INVALID_CONTENT_TYPE','送信形式を確認してください。')
      else if (status === 400) fault = new Fault(400,'INVALID_INPUT','送信形式を確認してください。')
      else {
        console.error('request failed',res.locals.correlation,code ?? 'internal')
        fault = new Fault(503,'SERVICE_UNAVAILABLE','処理結果を確認できません。時間をおいて再試行してください。',true)
      }
    }
    res.status(fault.status).json({ code:fault.code,message:fault.message,field_errors:fields,
      correlation_id:res.locals.correlation,retryable:fault.retryable })
  })
  return app
}
