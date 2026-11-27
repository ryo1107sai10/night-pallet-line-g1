import {agencyEnrollmentPath,agencyEnrollmentInput,readAgencyEnrollment} from './agency-enrollment.js'
import {piyomaruInfo,configurePiyomaru,askPiyomaru,createPiyomaruJob,readPiyomaruJob,actPiyomaruJob,piyoSettingInput,piyoQuestionInput,piyoJobInput,piyoActionInput,piyoNoteInput,rememberPiyomaruNote,removePiyomaruNote} from './piyomaru.js'
import {createPiyomaruMediaSource} from './piyomaru-library.js'
import {createMaterialStorage,createMaterialDraft,materialAsset,materialHistory,materialDraftInput,materialPublishInput,publishMaterial,uploadMaterialChunk} from './piyomaru-materials.js'
import {acceptanceInput,masterHealth,platformHealth,probeStore,recordStoreAcceptance} from './store-health.js'
import {intakeView,saveIntake,changeIntake,intakeSaveInput,intakeActionInput} from './recruitment-intake.js'
import { agencyMasterDetails, inviteAgencyPair, confirmAgencyPair, cancelAgencyPair, authenticatePlatformWorkspace, enterPlatformTenant, inviteAgencyMaster, platformPrincipal, platformSession, platformTenants, platformWorkspace, promoteAgencyMaster, removeAgencyMaster, requireSupervisor } from './platform.js'
import { publishTour, readTours, tourId, tourInput } from './tours.js'
import { completeSupervisorHandoff, handoffCompletion, handoffSetup, readSupervisorHandoff, supervisorHandoffPath } from './supervisor-handoff.js'
import {completeMasterPasswordReset,masterPasswordResetPath,resetCompletion} from './master-password-reset.js'
import { checkAgencyAccess } from './agency-access.js'
import express, { type Request, type Response, type NextFunction } from 'express'
import { fileURLToPath } from 'node:url'
import type pg from 'pg'
import { z } from 'zod'
import {
  type Actor, type Config, type DB, Fault, audit, automationForStore, conflict, forbidden, email, newId, once, purpose, revision,
  route, scope, text, tx, uuid,
} from './core.js'
import { accept, authenticate, createInvite, disableStaff, gate, login, logout, memberRole,
  requireAdmin, sessionCookie, storeAccess, storeList } from './auth.js'
import {
  channel, channelCredentials, connectionTestEvent, connectionSchema, consoleSchema, createChannel, evidence, issueTester, LineAPI,
  queueTest, receiveModuleWebhook, receiveWebhook, replaceCredentials, replaceCredentialsSchema, summary,
} from './line.js'
import {beginModuleLink, finishModuleLink, moduleConfigured, moduleReturn, moduleReturnPath,
  moduleStart, rememberModuleBot, requireModule} from './line-module.js'
import { changeOnboarding, guideLookup, guidePath, guideSubmission, listOnboarding, markOnboardingRegistered,
  onboardingChange, onboardingDetails, readGuide, submitGuide } from './line-onboarding.js'
import {uploadStudioImage,listStudioImages,publicStudioImage,imageInputLimit} from './studio-media.js'
import { createScenario, saveScenario, saveScenarioFolder, scenarioMetrics, studioPresence, publicationReview, scenarioReadiness, scenarioDetail, scenarioList, scenarioTesters, scenarioTestStatus, queueScenarioTest, transitionScenario, versionDetail } from './scenario.js'
import { lockDispatch, setStop, workOnce } from './jobs.js'
import { customerFields, consentVersion, updateProfile, profileInput, authenticateCustomer,
  customerSessionCookie, setPreferences, customerById, selfPreferenceInput, emitDelivery } from './customer.js'
import { bookingInput, changeBooking, createSlot, listBookings, listSlots, ownBookingChange, ownBookingInput,
  requestBooking, slotInput, bookingChange, staffBooking } from './booking.js'
import { endScope, locationOf, updateAutomation } from './automation.js'
import { changeInterviewVisibility, confirmInterview, interviewAccess, interviewApplicant, interviewCalendar, interviewChange,
  interviewBatchInput, interviewBatchPublish, checkInterviewBatch, publishInterviewBatch,
  interviewCreate, interviewDates, interviewSlotInput, interviewVisibility, publishInterviewSlot, staffInterviewOverview,
  guestInterviewCreate, interviewHours, saveInterviewHours, startGuestInterviewSession,
  updateInterview, recruitmentSubject } from './interviews.js'
import { addBlock, availabilityOverview, beginCalendarLink, blockInput, claimCalendarLink, finishCalendarLink,
  googleCalendarInput, managedCalendarInput, linkManagedCalendar, googleCalendarReturn, googleFromEnvironment, removeBlock, unlinkInterviewCalendar } from './interview-availability.js'
import { featureInput, recruitmentAcquisitionInput, recruitmentSetupInput, recruitmentSetupView, requireFeature, saveRecruitmentAcquisition, saveRecruitmentSetup, saveStoreFeatures, storeFeatures } from './store-features.js'
import { customerTagInput, listTags, saveCustomerTags, saveTagRule, tagFilter, tagRuleInput,
  listTagSegments, removeTagSegment, saveTagSegment, tagSegmentInput, tagSegmentDelete } from './customer-tags.js'
import { caseInput, formFor, formInput, formQuery, formResponse, listForms, listRecruitment, responses, saveForm, submitForm, updateCase,
  type WorkflowSubject } from './forms.js'
import { queueSourceTest, saveSource, setSourceStatus, sourceInput, sourceReport, sourceReportInput, sourceStatus, sourceQR, sourceTestInput, sourceTesters } from './sources.js'
import { applicantTagCatalog, tagOverview, tagListQuery, saveApplicantTagSettings, tagSettingsInput, saveApplicantTag, tagDefinitionInput, saveSubjectTags, subjectTagsInput, tagCampaignInput, tagCampaignConfirm, previewTagCampaign, queueTagCampaign, stopTagCampaign } from './applicant-tags.js'
import { approvalInput, approveCampaign, campaignInput, campaignOverview, prepareCampaign, stopCampaign } from './campaigns.js'
import { createMenuTemplate, listMenus, menuInput, menuTemplateInput, menuTestInput, menuTesters, saveMenus, testRichMenu, validateMenus } from './rich-menus.js'
import { interviewNotices, noticeInput, setInterviewNotices, setWaitlist, waitlistInput } from './interview-notices.js'
import { retryService, serviceHistory } from './service-delivery.js'
import { changeThread, classifyThread, createInboxTemplate, handoffInput, changeHandoff, inboxClassify, inboxEdit,
  inboxMessages, inboxOverview, inboxTemplateEdit, inboxTemplateInput, inboxTemplates, inboxText, updateInboxTemplate, writeInbox } from './inbox.js'
import { hostInput, queueGoogleSync, saveHost } from './interview-hosts.js'
import { redeemInterviewLink } from './interview-link.js'
import { completeStoreSetup, confirmStoreSetup, createRegistration, designateRegistrationMaster,
  registrationInput, registrationProgress, reopenStoreSetup, setupConfirmInput, setupRevisionInput,
  storeSetupState } from './registration.js'
import { CUSTOMER_LINK_SESSION_TTL_SECONDS, redeemCustomerLink } from './customer-link.js'
import { workflowChecks } from './workflow-checks.js'
import { dispatchLineWork, lineDispatchFromEnvironment, lineDispatchInput, lineDispatchPath } from './line-dispatch.js'
import { scheduledWorkFromEnvironment, scheduledWorkPath } from './scheduled-work.js'
import { operationsDashboard } from './operations-dashboard.js'




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

export function createApp(pool: pg.Pool, cfg: Config, line = new LineAPI(), google = googleFromEnvironment(cfg),
  dispatch = lineDispatchFromEnvironment(cfg),
  scheduled = scheduledWorkFromEnvironment(cfg,async()=>{await workOnce(pool,cfg,line,google)})) {
  const app = express()
  const api = express.Router({mergeParams:true})
  const workspace = express.Router({mergeParams:true})
  const wakeLine = async (store: string, channel: string, source: 'webhook'|'service'|'applicant') => {
    if (!dispatch) return
    try {
      let allowed=automationForStore(cfg,store)
      if(!allowed&&cfg.automationTenants?.length){
        const {rows:[route]}=await pool.query<{tenant_id:string}>(
          'SELECT tenant_id FROM channel_route WHERE id=$1 AND store_id=$2',[channel,store])
        allowed=automationForStore(cfg,store,route?.tenant_id)
      }
      if(allowed)await dispatch.wake({channel,source})
    }catch { console.warn('LINE dispatch enqueue failed; scheduled worker will recover') }
  }
  app.disable('x-powered-by')
  app.use((req,res,next) => {
    res.locals.correlation = newId()
    res.set({ 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer',
      'Cache-Control':'no-store', 'X-Frame-Options':'DENY', 'X-Request-ID':res.locals.correlation,
      'Content-Security-Policy':"default-src 'self'; img-src 'self' data:"+(/(?:^|\/)studio(?:\/|$)/.test(req.path)?" https:":"")+"; connect-src 'self' https://*.line.me https://*.line-apps.com https://*.line-scdn.net; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
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
  for (const page of ['google-return.html','guest.html','token.html']) {
    app.get('/interview/'+page,(_req,res)=>res.sendFile(here('../public/interview/'+page)))
  }
  const interviewAssets=express.static(here('../public/interview'),{index:false,redirect:false})
  workspace.use('/interview',(req,res,next)=>{
    if (/\.(mjs|css)$/i.test(req.path)) interviewAssets(req,res,next)
    else next()
  })
  app.get('/customer/token.html',(_req,res)=>res.sendFile(here('../public/customer/token.html')))
  const customerAssets=express.static(here('../public/customer'),{index:false,redirect:false})
  workspace.use('/customer',(req,res,next)=>{
    if (/\.(mjs|css)$/i.test(req.path)) customerAssets(req,res,next)
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
  workspace.get('/agency-line/',async(req,res)=>{
    res.set('X-Robots-Tag','noindex, nofollow')
    const actor=await pageActor(req)
    if(!actor?.agency||actor.role!=='admin'){
      res.redirect(302,actor?.role==='admin'?'/master/':'/staff/')
      return
    }
    res.sendFile(here('../public/agency-line.html'))
  })
  app.get(supervisorHandoffPath,(_req,res)=>{
    res.set('X-Robots-Tag','noindex, nofollow').sendFile(here('../public/supervisor-handoff.html'))
  })
  app.get(agencyEnrollmentPath,(_req,res)=>{res.set({'X-Robots-Tag':'noindex, nofollow','Cache-Control':'no-store','Referrer-Policy':'no-referrer'}).sendFile(here('../public/agency-enrollment.html'))})
  app.get(masterPasswordResetPath,(_req,res)=>{
    res.set('X-Robots-Tag','noindex, nofollow').sendFile(here('../public/master-recovery.html'))
  })
  app.get('/platform/',async(req,res)=>{
    res.set('X-Robots-Tag','noindex, nofollow')
    const signedIn=await tx(pool,db=>authenticate(db,platformCredential(req),'platform')).then(()=>true,error=>{
      if (error instanceof Fault && error.status===401) return false
      throw error
    })
    res.sendFile(here(signedIn?'../public/platform.html':'../public/staff-login.html'))
  })
  app.get('/platform/tours/',async(req,res)=>{
    res.set('X-Robots-Tag','noindex, nofollow')
    try { await tx(pool,db=>platformPrincipal(db,platformCredential(req))) }
    catch(error){
      if(error instanceof Fault && error.status===401){res.redirect(302,'/platform/');return}
      throw error
    }
    res.sendFile(here('../public/tour-editor.html'))
  })
  app.get(guidePath,(_req,res)=>res.set('X-Robots-Tag','noindex, nofollow').sendFile(here('../public/line-invite.html')))
  app.get(moduleReturnPath,(_req,res)=>res.sendFile(here('../public/line-module-return.html')))
  app.get('/book/:connection',(req,res)=>{
    idOf(req,'connection')
    res.sendFile(here('../public/interview/guest.html'))
  })
  app.get('/reserve/:connection',(req,res)=>{
    idOf(req,'connection')
    res.set('X-Robots-Tag','noindex, nofollow').sendFile(here('../public/interview/token.html'))
  })
  app.get('/account/:connection',(req,res)=>{
    idOf(req,'connection')
    res.set('X-Robots-Tag','noindex, nofollow').sendFile(here('../public/customer/token.html'))
  })
  const staticAssets=new Set(['style.css','admin.mjs','line-setup.mjs','line-invite.mjs','line-module-return.mjs','platform.mjs','workspace-path.mjs','agency.mjs','agency-line.mjs','supervisor-handoff.mjs','master-recovery.mjs','agency-enrollment.mjs','dashboard.mjs','master-team.mjs','store-health.mjs'])
  const tourAssets=new Set(['tour.mjs','tour.css','tour-editor.mjs','piyomaru.mjs','piyomaru.css','piyomaru-atlas.png'])
  app.get('/static/:asset',async(req,res,next)=>{
    const asset=req.params.asset
    if(tourAssets.has(asset)){
      await tx(pool,db=>authenticate(db,platformCredential(req),'platform'))
      res.sendFile(here('../public/'+asset))
    }else if (staticAssets.has(asset)) res.sendFile(here('../public/'+asset))
    else next()
  })
  const servePiyomaruMedia=createPiyomaruMediaSource()
  const materialStorage=createMaterialStorage()
  app.get(['/platform/piyomaru/material/:material','/platform/piyomaru/material/:material/page/:page'],async(req,res)=>{
    const revision=req.query.revision===undefined?undefined:z.uuid().parse(req.query.revision)
    const asset=await tx(pool,db=>materialAsset(db,platformCredential(req),String(req.params.material),revision))
    await servePiyomaruMedia(req,res,asset)
  })
  app.get('/line-media/:file',async(req,res)=>{
    const id=z.string().regex(/^[0-9a-f-]{36}\.jpg$/i).parse(req.params.file).slice(0,-4)
    const content=await publicStudioImage(pool,uuid.parse(id))
    res.set({'Content-Type':'image/jpeg','Cache-Control':'public,max-age=86400,immutable','Content-Security-Policy':"default-src 'none'; sandbox"}).send(content)
  })
  app.use('/assets',express.static(here('./assets'),{index:false}))
  app.post(lineDispatchPath,express.json({limit:'1kb',strict:true}),async(req,res)=>{
    if (!dispatch || !await dispatch.verify(req.get('Authorization') ?? '')) {
      throw new Fault(403,'FORBIDDEN','この操作を実行できる権限がありません。')
    }
    await dispatchLineWork(pool,cfg,line,lineDispatchInput.parse(req.body))
    res.status(204).end()
  })
  app.post(scheduledWorkPath,async(req,res)=>{
    if (!scheduled || !await scheduled.verify(req.get('Authorization') ?? '')) {
      throw new Fault(403,'FORBIDDEN','この操作を実行できる権限がありません。')
    }
    const started = performance.now()
    await scheduled.run()
    console.info(JSON.stringify({event:'scheduled_work_completed',elapsed_ms:Math.round(performance.now()-started)}))
    res.status(204).end()
  })
  workspace.use('/api/v1',api)
  app.use(platformWorkspace+'/:platformTenant',workspace)
  app.use(workspace)

  api.post('/webhooks/line/:connection',express.raw({ type:'application/json',limit:'1mb',inflate:false }),
    async (req,res)=>{
      const received = await receiveWebhook(pool,cfg,idOf(req,'connection'),
        Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),req.get('X-Line-Signature') ?? '')
      if (received) await wakeLine(received.store_id,received.id,'webhook')
      res.status(200).json({ received:true })
    })
  api.post('/webhooks/line-module',express.raw({type:'application/json',limit:'1mb',inflate:false}),async(req,res)=>{
    const received = await receiveModuleWebhook(pool,cfg,Buffer.isBuffer(req.body)?req.body:Buffer.alloc(0),req.get('X-Line-Signature')??'')
    if (received) await wakeLine(received.store_id,received.id,'webhook')
    res.json({received:true})
  })
  api.put('/platform/piyomaru/library/upload/:revision',async(req,_res,next)=>{
    if(req.get('Origin')!==cfg.origin)throw new Fault(403,'INVALID_ORIGIN','操作元を確認できません。')
    if(!req.is('application/octet-stream'))throw new Fault(415,'INVALID_CONTENT_TYPE','教材ファイルを指定してください。')
    await tx(pool,db=>platformPrincipal(db,platformCredential(req)))
    next()
  },express.raw({type:'application/octet-stream',limit:'4mb',inflate:false}),async(req,res)=>{
    const offset=z.string().regex(/^\d{1,9}$/).transform(Number).parse(req.query.offset)
    res.json(await tx(pool,db=>uploadMaterialChunk(db,cfg,platformCredential(req),idOf(req,'revision'),offset,req.body,materialStorage)))
  })

  api.use((req,_res,next)=>{
    const mutable = !['GET','HEAD','OPTIONS'].includes(req.method)
    if (mutable && req.get('Origin') !== cfg.origin) {
      throw new Fault(403,'INVALID_ORIGIN','操作元を確認できません。')
    }
    const media=req.method==='POST'&&/^\/stores\/[0-9a-f-]{36}\/scenarios\/media$/i.test(req.path)
    if (mutable && !req.is('application/json') && !(media&&(req.is('image/jpeg')||req.is('image/png')))) {
      throw new Fault(415,'INVALID_CONTENT_TYPE','JSON形式で送信してください。')
    }
    next()
  })
  const normalJSON=express.json({limit:'32kb',strict:true}),scenarioJSON=express.json({limit:'2mb',strict:true,inflate:false})
  api.use(async(req,res,next)=>{
    const large=/^\/stores\/([0-9a-f-]{36})\/scenarios(?:\/[0-9a-f-]{36})?$/i.exec(req.path)
    const media=/^\/stores\/([0-9a-f-]{36})\/scenarios\/media$/i.exec(req.path)
    if((large&&['POST','PATCH'].includes(req.method))||(media&&req.method==='POST')){
      // Authenticate before accepting larger request bodies, then apply the regular endpoint checks too.
      await tx(pool,async db=>{const actor=await requestActor(db,req);await storeAccess(db,actor,uuid.parse((large??media)![1]),true)})
      if(media)return next()
      return scenarioJSON(req,res,next)
    }
    return normalJSON(req,res,next)
  })
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
  api.get('/platform/tours',async(req,res)=>{
    res.json(await tx(pool,db=>readTours(db,platformCredential(req))))
  })
  api.put('/platform/tours/:tour',async(req,res)=>{
    const id=tourId.parse(req.params.tour)
    const input=tourInput.parse(req.body)
    res.json(await tx(pool,db=>publishTour(db,platformCredential(req),id,input)))
  })
  api.get('/platform/piyomaru',async(req,res)=>{
    res.json(await tx(pool,db=>piyomaruInfo(db,cfg,platformCredential(req))))
  })
  api.get('/platform/piyomaru/library/:material',async(req,res)=>{
    res.json(await tx(pool,db=>materialHistory(db,platformCredential(req),String(req.params.material))))
  })
  api.post('/platform/piyomaru/library/draft',async(req,res)=>{
    const data=materialDraftInput.parse(req.body)
    res.status(201).json(await tx(pool,db=>createMaterialDraft(db,cfg,platformCredential(req),data,materialStorage)))
  })
  api.post('/platform/piyomaru/library/publish',async(req,res)=>{
    res.json(await tx(pool,db=>publishMaterial(db,cfg,platformCredential(req),materialPublishInput.parse(req.body))))
  })
  api.get('/platform/store-health',async(req,res)=>{
    res.json(await tx(pool,db=>platformHealth(db,cfg,google,platformCredential(req))))
  })
  for(const action of ['probe','acceptance'] as const)api.post('/platform/store-health/:tenant/:store/'+action,async(req,res)=>{
    const store=idOf(req,'store'),tenant=idOf(req,'tenant')
    res.json(await tx(pool,async db=>{
      await enterPlatformTenant(db,platformCredential(req),tenant)
      const actor=await authenticatePlatformWorkspace(db,platformCredential(req),tenant)
      await storeAccess(db,actor,store,true)
      if(action==='probe'){z.strictObject({}).parse(req.body);return probeStore(db,cfg,google,line,actor,store)}
      return recordStoreAcceptance(db,cfg,google,actor,store,acceptanceInput.parse(req.body))
    }))
  })
  api.put('/platform/piyomaru/settings',async(req,res)=>{
    const data=piyoSettingInput.parse(req.body)
    res.json(await tx(pool,db=>configurePiyomaru(db,cfg,platformCredential(req),data)))
  })
  api.post('/platform/piyomaru/ask',async(req,res)=>{
    res.json(await askPiyomaru(pool,cfg,platformCredential(req),piyoQuestionInput.parse(req.body)))
  })
  api.post('/platform/piyomaru/knowledge',async(req,res)=>{
    const data=piyoNoteInput.parse(req.body)
    res.status(201).json(await tx(pool,db=>rememberPiyomaruNote(db,cfg,platformCredential(req),data)))
  })
  api.delete('/platform/piyomaru/knowledge/:note',async(req,res)=>{
    res.json(await tx(pool,db=>removePiyomaruNote(db,platformCredential(req),idOf(req,'note'))))
  })
  api.post('/platform/piyomaru/jobs',async(req,res)=>{
    const data=piyoJobInput.parse(req.body)
    res.status(201).json(await tx(pool,db=>createPiyomaruJob(db,cfg,platformCredential(req),data,keyOf(req))))
  })
  api.get('/platform/piyomaru/jobs/:job',async(req,res)=>{
    res.json(await tx(pool,db=>readPiyomaruJob(db,cfg,platformCredential(req),idOf(req,'job'))))
  })
  api.post('/platform/piyomaru/jobs/:job/refresh',async(req,res)=>{
    z.strictObject({}).parse(req.body)
    res.json(await tx(pool,db=>readPiyomaruJob(db,cfg,platformCredential(req),idOf(req,'job'),true)))
  })
  api.post('/platform/piyomaru/jobs/:job/action',async(req,res)=>{
    const data=piyoActionInput.parse(req.body)
    res.json(await tx(pool,db=>actPiyomaruJob(db,cfg,platformCredential(req),idOf(req,'job'),data)))
  })
  api.get('/platform/tenants',async(req,res)=>{
    res.json(await tx(pool,db=>platformTenants(db,platformCredential(req))))
  })
  api.post('/platform/registrations',async(req,res)=>{
    const data=registrationInput.parse(req.body)
    const principal=await tx(pool,db=>platformPrincipal(db,platformCredential(req)))
    res.status(201).json(await tx(pool,db=>createRegistration(db,cfg,principal,data,keyOf(req))))
  })
  api.get('/platform/registrations/progress',async(req,res)=>{
    res.json(await tx(pool,async db=>registrationProgress(db,await platformPrincipal(db,platformCredential(req)))))
  })
  api.post('/platform/registrations/:tenant/master',async(req,res)=>{
    const {address}=z.strictObject({address:email}).parse(req.body)
    res.json(await tx(pool,async db=>designateRegistrationMaster(db,
      await platformPrincipal(db,platformCredential(req)),idOf(req,'tenant'),address)))
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
  api.post('/platform/handoff/setup',async(req,res)=>{
    const {handoff}=handoffSetup.parse(req.body)
    res.json(await readSupervisorHandoff(pool,cfg,handoff,address(req)))
  })
  api.post('/platform/handoff/complete',async(req,res)=>{
    const result=await completeSupervisorHandoff(pool,cfg,handoffCompletion.parse(req.body),address(req))
    res.set('Set-Cookie',sessionCookie(cfg,'','platform')).json(result)
  })
  api.post('/auth/master/enrollment',async(req,res)=>{const {invite}=agencyEnrollmentInput.parse(req.body);res.set('Cache-Control','no-store').json(await readAgencyEnrollment(pool,cfg,invite,address(req)))})
  api.post('/auth/activate',async (req,res)=>{ res.json(await accept(pool,cfg,req.body,address(req))) })
  api.post('/auth/master/recovery',async(req,res)=>{
    const result=await completeMasterPasswordReset(pool,cfg,resetCompletion.parse(req.body),address(req))
    res.set('Set-Cookie',sessionCookie(cfg)).json(result)
  })

  const localCustomerSession = (req:Request) => req.headers.cookie?.split(';').map(value=>value.trim())
    .find(value=>value.startsWith('night_customer='))?.slice('night_customer='.length)
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
      return changeBooking(db,null,idOf(req,'booking'),{...p,reason:'本人の操作'},c)
    }))
  })
  const customerSubject=async(db:DB,req:Request):Promise<WorkflowSubject>=>{
    const c=await authenticateCustomer(db,localCustomerSession(req))
    return {tenant_id:c.tenant_id,store_id:c.store_id,channel_id:c.channel_id,purpose:'customer',subject:c.id}
  }

  const interviewCredential=(req:Request)=>req.headers.cookie?.split(';').map(value=>value.trim())
    .find(value=>value.startsWith('night_interview='))?.slice('night_interview='.length)
  api.get('/interview/calendar',async(req,res)=>{
    const {start}=interviewDates.parse(req.query)
    res.json(await tx(pool,async db=>interviewCalendar(db,await interviewApplicant(db,interviewCredential(req)),google,start)))
  })
  async function changeApplicantInterview<T>(req: Request,
    apply: (db: DB, applicant: Awaited<ReturnType<typeof interviewApplicant>>) => Promise<T>) {
    const {applicant,result} = await tx(pool,async db=>{
      const applicant = await interviewApplicant(db,interviewCredential(req),true)
      return {applicant,result:await apply(db,applicant)}
    })
    await wakeLine(applicant.store_id,applicant.channel_id,'service')
    return result
  }
  api.post('/interview/bookings',async(req,res)=>{
    const input=interviewCreate.parse(req.body)
    res.status(201).json(await changeApplicantInterview(req,(db,applicant)=>confirmInterview(db,cfg,applicant,input,google)))
  })
  api.patch('/interview/bookings/:booking',async(req,res)=>{
    const input=interviewChange.parse(req.body)
    res.json(await changeApplicantInterview(req,(db,applicant)=>updateInterview(db,cfg,applicant,idOf(req,'booking'),input,google)))
  })
  api.post('/interview-link/:connection/redeem',async(req,res)=>{
    const connection=idOf(req,'connection')
    await gate(pool,cfg,'interview-link-redeem:'+connection+':'+address(req),60)
    const cookie=await redeemInterviewLink(pool,cfg,connection,req.body)
    res.set('Set-Cookie',cookie).json({signed_in:true})
  })
  api.post('/customer-link/:connection/redeem',async(req,res)=>{
    const connection=idOf(req,'connection')
    await gate(pool,cfg,'customer-link-redeem:'+connection+':'+address(req),60)
    const value=await redeemCustomerLink(pool,cfg,connection,req.body)
    res.set('Set-Cookie',customerSessionCookie(cfg,value,CUSTOMER_LINK_SESSION_TTL_SECONDS)).json({signed_in:true})
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
    const {subject,result} = await tx(pool,async db=>{
      const subject = await applicantSubject(db,req)
      return {subject,result:await setInterviewNotices(db,cfg,subject,enabled)}
    })
    if (enabled) await wakeLine(subject.store_id,subject.channel_id,'service')
    res.json(result)
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
      const {identity,result}=await tx(pool,async db=>{
        const identity=await subject(db,req)
        return {identity,result:await submitForm(db,cfg,identity,data)}
      })
      if(result.queued)await wakeLine(identity.store_id,identity.channel_id,'applicant')
      res.status(201).json({submitted:result.submitted})
    })
  }

  type Action<T=unknown> = (db: DB,actor: Actor,req: Request) => Promise<T>
  const staffAction = <T>(req: Request,action: Action<T>) =>
    tx(pool,async db=>{
      const actor=await requestActor(db,req)
      checkAgencyAccess(actor,req)
      return action(db,actor,req)
    })
  const staff = (action: Action,status=200) => async (req: Request,res: Response) => {
    res.status(status).json(await staffAction(req,action))
  }
  const inStore = (action: Action,manage = true,status=200) => staff(async (db,actor,req)=>{
    await storeAccess(db,actor,idOf(req,'store'),manage)
    return action(db,actor,req)
  },status)
  const requireAgencyManualConnection=(actor:Actor,c:Awaited<ReturnType<typeof channel>>)=>{
    if(actor.agency&&(c.module_channel_id||c.purpose!=='recruitment'))throw forbidden()
  }
  const withChannel = (action: (db:DB,actor:Actor,req:Request,c:Awaited<ReturnType<typeof channel>>)=>Promise<unknown>,
    status=200)=>inStore(async (db,actor,req)=>{
      const c=await channel(db,idOf(req,'connection'))
      requireAgencyManualConnection(actor,c)
      return action(db,actor,req,c)
    },true,status)

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
  api.get('/dashboard',staff((db,actor)=>operationsDashboard(db,actor)))
  api.get('/store-health',staff((db,actor)=>masterHealth(db,cfg,google,actor)))
  api.post('/stores/:store/health/probe',inStore(async(db,actor,req)=>{
    z.strictObject({}).parse(req.body);return probeStore(db,cfg,google,line,actor,idOf(req,'store'))
  }))
  api.post('/stores/:store/health/acceptance',inStore((db,actor,req)=>recordStoreAcceptance(db,cfg,google,actor,idOf(req,'store'),acceptanceInput.parse(req.body))))
  api.get(workflow+'/settings',workflowStaff((db,_actor,req)=>storeFeatures(db,idOf(req,'store'))))
  api.patch(workflow+'/settings/acquisition',workflowStaff((db,actor,req)=>{
    if(workPurpose(req)!=='recruitment')throw forbidden()
    return saveRecruitmentAcquisition(db,actor,idOf(req,'store'),recruitmentAcquisitionInput.parse(req.body))
  }))
  api.get(workflow+'/checks',workflowStaff((db,_actor,req)=>workflowChecks(db,cfg,idOf(req,'store'),workPurpose(req),google)))
  api.get(workflow+'/delivery',workflowStaff((db,_actor,req)=>
    serviceHistory(db,cfg,idOf(req,'store'),workPurpose(req),req.query.failures==='1')))
  api.post(workflow+'/delivery/:delivery/retry',async(req,res)=>{
    const store = idOf(req,'store'), usage = workPurpose(req)
    const job=await staffAction(req,async(db,actor)=>{
      await workflowAccess(db,actor,store,usage)
      return retryService(db,cfg,actor,store,usage,idOf(req,'delivery'))
    })
    await wakeLine(store,job.channel_id,'service')
    res.json({queued:true})
  })
  api.get(workflow+'/inbox',workflowStaff((db,actor,req)=>inboxOverview(db,idOf(req,'store'),workPurpose(req),actor.platform?actor.id:undefined)))
  const templates=workflow+'/inbox/templates'
  api.get(templates,workflowStaff((db,_actor,req)=>inboxTemplates(db,cfg,idOf(req,'store'),workPurpose(req))))
  api.post(templates,workflowStaff((db,actor,req)=>
    createInboxTemplate(db,cfg,actor,idOf(req,'store'),workPurpose(req),keyOf(req),inboxTemplateInput.parse(req.body)),201))
  api.patch(templates+'/:template',workflowStaff((db,actor,req)=>{
    const {revision:version,...input}=inboxTemplateEdit.parse(req.body)
    return updateInboxTemplate(db,cfg,actor,idOf(req,'store'),workPurpose(req),idOf(req,'template'),version,input)
  }))
  api.delete(templates+'/:template',workflowStaff((db,actor,req)=>
    updateInboxTemplate(db,cfg,actor,idOf(req,'store'),workPurpose(req),idOf(req,'template'),
      z.strictObject({revision}).parse(req.body).revision)))
  api.get(workflow+'/inbox/:thread',workflowStaff((db,_actor,req)=>inboxMessages(db,cfg,idOf(req,'store'),workPurpose(req),idOf(req,'thread'))))
  api.patch(workflow+'/inbox/:thread',workflowStaff((db,actor,req)=>
    changeThread(db,actor,idOf(req,'store'),workPurpose(req),idOf(req,'thread'),inboxEdit.parse(req.body))))
  api.patch(workflow+'/inbox/:thread/handoff',async(req,res)=>{
    const store=idOf(req,'store'),use=workPurpose(req)
    const {channel,queued,handoff_until}=await staffAction(req,async(db,actor)=>{
      await workflowAccess(db,actor,store,use)
      return changeHandoff(db,actor,store,use,idOf(req,'thread'),handoffInput.parse(req.body))
    })
    if(queued)await wakeLine(store,channel,'applicant')
    res.json({handoff_until})
  })
  api.post(workflow+'/inbox/:thread',async(req,res)=>{
    const store = idOf(req,'store'), usage = workPurpose(req)
    const {channel,...message} = await staffAction(req,async(db,actor)=>{
      await workflowAccess(db,actor,store,usage)
      return writeInbox(db,cfg,actor,store,usage,idOf(req,'thread'),keyOf(req),inboxText.parse(req.body))
    })
    if (channel) await wakeLine(store,channel,'service')
    res.status(201).json(message)
  })
  const intake='/stores/:store/intake'
  api.get(intake,inStore((db,actor,req)=>inboxOverview(db,idOf(req,'store'),'unclassified',actor.platform?actor.id:undefined)))
  api.get(intake+'/:thread',inStore((db,_actor,req)=>inboxMessages(db,cfg,idOf(req,'store'),'unclassified',idOf(req,'thread'))))
  api.patch(intake+'/:thread',inStore((db,actor,req)=>
    classifyThread(db,actor,idOf(req,'store'),idOf(req,'thread'),inboxClassify.parse(req.body))))
  api.patch(intake+'/:thread/handoff',async(req,res)=>{
    const store=idOf(req,'store')
    const {channel,queued,handoff_until}=await staffAction(req,async(db,actor)=>{
      await storeAccess(db,actor,store,true)
      return changeHandoff(db,actor,store,'unclassified',idOf(req,'thread'),handoffInput.parse(req.body))
    })
    if(queued)await wakeLine(store,channel,'applicant')
    res.json({handoff_until})
  })
  api.get('/stores/:store/recruitment-intake/:channel',staff(async(db,actor,req)=>{
    const store=idOf(req,'store')
    await interviewAccess(db,actor,store)
    return intakeView(db,actor,store,idOf(req,'channel'))
  }))
  api.put('/stores/:store/recruitment-intake',staff(async(db,actor,req)=>{
    const store=idOf(req,'store')
    await interviewAccess(db,actor,store)
    return saveIntake(db,actor,store,intakeSaveInput.parse(req.body))
  }))
  api.post('/stores/:store/recruitment-intake/action',staff(async(db,actor,req)=>{
    const store=idOf(req,'store')
    await interviewAccess(db,actor,store)
    return changeIntake(db,cfg,actor,store,intakeActionInput.parse(req.body))
  }))
  api.get(workflow+'/forms',workflowStaff((db,_actor,req)=>listForms(db,idOf(req,'store'),workPurpose(req))))
  api.put(workflow+'/forms',workflowStaff((db,actor,req)=>saveForm(db,cfg,actor,idOf(req,'store'),workPurpose(req),keyOf(req),formInput.parse(req.body))))
  api.get(workflow+'/responses',workflowStaff((db,_actor,req)=>responses(db,cfg,idOf(req,'store'),workPurpose(req))))
  api.get(workflow+'/sources',workflowStaff((db,_actor,req)=>
    sourceReport(db,idOf(req,'store'),workPurpose(req),sourceReportInput.parse(req.query).days)))
  api.post(workflow+'/sources',workflowStaff((db,actor,req)=>
    saveSource(db,actor,idOf(req,'store'),workPurpose(req),sourceInput.parse(req.body)),201))
  api.get(workflow+'/sources/:source/qr',workflowStaff((db,_actor,req)=>sourceQR(db,idOf(req,'store'),workPurpose(req),idOf(req,'source'))))
  api.get(workflow+'/sources/:source/testers',workflowStaff((db,actor,req)=>{
    if(workPurpose(req)!=='recruitment')throw forbidden()
    return sourceTesters(db,cfg,actor,idOf(req,'store'),idOf(req,'source'))
  }))
  api.post(workflow+'/sources/:source/test',workflowStaff((db,actor,req)=>{
    if(workPurpose(req)!=='recruitment')throw forbidden()
    return queueSourceTest(db,cfg,actor,idOf(req,'store'),idOf(req,'source'),sourceTestInput.parse(req.body).tester,keyOf(req))
  },202))
  api.patch(workflow+'/sources/:source',workflowStaff((db,actor,req)=>
    setSourceStatus(db,actor,idOf(req,'store'),workPurpose(req),idOf(req,'source'),sourceStatus.parse(req.body).active)))
  api.post(workflow+'/rich-menus/:connection/templates',workflowStaff(async(db,actor,req)=>{
    if(workPurpose(req)!=='recruitment')throw forbidden()
    return createMenuTemplate(db,cfg,line,actor,idOf(req,'store'),idOf(req,'connection'),keyOf(req),menuTemplateInput.parse(req.body).variant)
  },201))
  api.get(workflow+'/rich-menus/:connection/testers',workflowStaff((db,actor,req)=>{
    if(workPurpose(req)!=='recruitment')throw forbidden()
    return menuTesters(db,cfg,actor,idOf(req,'store'),idOf(req,'connection'))
  }))
  api.post(workflow+'/rich-menus/:connection/test',workflowStaff(async(db,actor,req)=>{
    if(workPurpose(req)!=='recruitment')throw forbidden()
    await gate(pool,cfg,'menu-test:'+address(req),30)
    return testRichMenu(db,cfg,line,actor,idOf(req,'store'),idOf(req,'connection'),menuTestInput.parse(req.body).tester)
  }))
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
  const tags=workflow+'/tags'
  const tagStaff=(action:Action,status=200)=>inStore((db,actor,req)=>{
    if(workPurpose(req)!=='recruitment')throw forbidden()
    return action(db,actor,req)
  },true,status)
  api.get(tags,tagStaff((db,actor,req)=>tagOverview(db,cfg,actor,idOf(req,'store'),tagListQuery.parse(req.query))))
  api.get(tags+'/catalog',tagStaff((db,actor,req)=>applicantTagCatalog(db,actor,idOf(req,'store'))))
  api.patch(tags+'/settings',tagStaff((db,actor,req)=>saveApplicantTagSettings(db,actor,idOf(req,'store'),tagSettingsInput.parse(req.body))))
  api.put(tags+'/definitions',tagStaff((db,actor,req)=>saveApplicantTag(db,actor,idOf(req,'store'),tagDefinitionInput.parse(req.body))))
  api.patch(tags+'/subjects/:subject',async(req,res)=>{
    const store=idOf(req,'store')
    const {saved,queued,channel}=await staffAction(req,async(db,actor)=>{
      await storeAccess(db,actor,store,true)
      if(workPurpose(req)!=='recruitment')throw forbidden()
      return saveSubjectTags(db,actor,store,idOf(req,'subject'),subjectTagsInput.parse(req.body))
    })
    // Queue only after the event and tag were committed.
    if(queued)await wakeLine(store,channel,'applicant')
    res.json({saved})
  })
  api.post(tags+'/campaigns/preview',tagStaff((db,actor,req)=>previewTagCampaign(db,cfg,actor,idOf(req,'store'),tagCampaignInput.parse(req.body))))
  api.post(tags+'/campaigns',async(req,res)=>{
    const store=idOf(req,'store')
    const {id,queued,channel}=await staffAction(req,async(db,actor)=>{
      await storeAccess(db,actor,store,true)
      if(workPurpose(req)!=='recruitment')throw forbidden()
      return queueTagCampaign(db,cfg,actor,store,keyOf(req),tagCampaignConfirm.parse(req.body))
    })
    if(queued&&channel)await wakeLine(store,channel,'applicant')
    res.status(201).json({id,queued})
  })
  api.post(tags+'/campaigns/:campaign/stop',tagStaff((db,actor,req)=>stopTagCampaign(db,actor,idOf(req,'store'),idOf(req,'campaign'))))
  api.get('/stores/:store/recruitment',interviewStaff((db,_actor,req)=>listRecruitment(db,cfg,idOf(req,'store'))))
  api.patch('/stores/:store/recruitment/:case',async(req,res)=>{
    const store=idOf(req,'store')
    const {saved,queued,channel}=await staffAction(req,async(db,actor)=>{
      await interviewAccess(db,actor,store)
      return updateCase(db,actor,store,idOf(req,'case'),caseInput.parse(req.body))
    })
    if(queued)await wakeLine(store,channel,'applicant')
    res.json(saved)
  })
  const campaigns='/stores/:store/campaigns'
  api.get(campaigns,inStore((db,_actor,req)=>campaignOverview(db,cfg,idOf(req,'store'))))
  api.post(campaigns,inStore((db,actor,req)=>prepareCampaign(db,cfg,actor,idOf(req,'store'),keyOf(req),campaignInput.parse(req.body)),true,201))
  api.post(campaigns+'/:campaign/approve',inStore((db,actor,req)=>
    approveCampaign(db,cfg,actor,idOf(req,'store'),idOf(req,'campaign'),approvalInput.parse(req.body))))
  api.post(campaigns+'/:campaign/stop',inStore((db,actor,req)=>stopCampaign(db,actor,idOf(req,'store'),idOf(req,'campaign'))))
  api.get('/stores/:store/interviews',interviewStaff((db,_actor,req)=>staffInterviewOverview(db,idOf(req,'store'),cfg,google)))
  api.post('/stores/:store/interviews/slots/batch/preview',interviewStaff((db,_actor,req)=>
    checkInterviewBatch(db,cfg,idOf(req,'store'),interviewBatchInput.parse(req.body),google)))
  api.post('/stores/:store/interviews/slots/batch',interviewStaff((db,actor,req)=>
    publishInterviewBatch(db,cfg,actor,idOf(req,'store'),keyOf(req),interviewBatchPublish.parse(req.body),google),201))
  api.patch('/stores/:store/interviews/hours',interviewStaff((db,actor,req)=>
    saveInterviewHours(db,actor,idOf(req,'store'),interviewHours.parse(req.body))))
  const availability='/stores/:store/interviews/availability'
  api.get(availability,interviewStaff((db,actor,req)=>availabilityOverview(db,idOf(req,'store'),google,actor.role==='admin')))
  api.post(availability+'/blocks',interviewStaff((db,actor,req)=>
    addBlock(db,cfg,actor,idOf(req,'store'),keyOf(req),blockInput.parse(req.body)),201))
  api.delete(availability+'/blocks/:block',interviewStaff((db,actor,req)=>
    removeBlock(db,actor,idOf(req,'store'),idOf(req,'block'))))
  api.post(availability+'/google/shared',interviewStaff((db,actor,req)=>
    linkManagedCalendar(db,actor,idOf(req,'store'),managedCalendarInput.parse(req.body).calendar_id,google)))
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
  api.post('/agency-master/pair/invite',staff((db,actor,req)=>{const {addresses,mfa_required}=z.strictObject({addresses:z.array(email).length(2),mfa_required:z.boolean().default(true)}).parse(req.body);return inviteAgencyPair(db,cfg,actor,addresses,keyOf(req),mfa_required)},201))
  api.post('/agency-master/pair/confirm',staff((db,actor,req)=>confirmAgencyPair(db,actor,z.strictObject({id:uuid}).parse(req.body).id)))
  api.post('/agency-master/pair/cancel',staff((db,actor,req)=>cancelAgencyPair(db,actor,z.strictObject({id:uuid}).parse(req.body).id)))
  api.post('/agency-master/invite',staff((db,actor,req)=>{
    const {address,mode,replace_id}=z.strictObject({address:email,mode:z.enum(['add','replace']).default('replace'),replace_id:uuid.optional()}).parse(req.body)
    return inviteAgencyMaster(db,cfg,actor,address,keyOf(req),{mode,replace_id})
  },201))
  api.post('/agency-master/promote',staff((db,actor,req)=>{
    const {pending,mode,replace_id}=z.strictObject({pending:uuid,mode:z.enum(['add','replace']).optional(),replace_id:uuid.optional()}).parse(req.body)
    if(replace_id&&!mode)throw new Fault(400,'MASTER_CHANGE','交代内容を確認してください。')
    return promoteAgencyMaster(db,actor,pending,mode?{mode,replace_id}:undefined)
  }))
  api.post('/agency-master/remove',staff((db,actor,req)=>{
    const {target}=z.strictObject({target:uuid}).parse(req.body)
    return removeAgencyMaster(db,actor,target)
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
  api.get('/stores/:store/setup',inStore((db,_actor,req)=>storeSetupState(db,cfg,idOf(req,'store')),false))
  api.post('/stores/:store/setup/confirm',inStore((db,actor,req)=>
    confirmStoreSetup(db,cfg,actor,idOf(req,'store'),setupConfirmInput.parse(req.body))))
  api.post('/stores/:store/setup/complete',inStore((db,actor,req)=>
    completeStoreSetup(db,cfg,actor,idOf(req,'store'),setupRevisionInput.parse(req.body))))
  api.post('/stores/:store/setup/reopen',inStore((db,actor,req)=>
    reopenStoreSetup(db,actor,idOf(req,'store'),setupRevisionInput.parse(req.body))))
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
    const {rows:notes}=await db.query(`SELECT kind,node_id,detail,occurred_at FROM delivery_note WHERE kind<>'studio_visit' ORDER BY id DESC LIMIT 60`)
    return {...settings,process_enabled:automationForStore(cfg,settings.id,_actor.tenant_id),jobs,notes}
  }))
  api.patch('/stores/:store/automation',inStore(async(db,actor,req)=>{
    requireAdmin(actor)
    const settings=z.strictObject({revision,enabled:z.boolean(),contract:z.boolean(),
      monthly_limit:z.int().min(1).max(1000000),reason:text(200)}).parse(req.body)
    return updateAutomation(db,cfg,actor,idOf(req,'store'),settings)
  }))

  // 現代理店マスター専用。北村さんの全体監督・顧客用途の配信設定は公開しない。
  const recruitmentSetup='/stores/:store/recruitment/setup'
  const requireAgencyMaster=(actor:Actor)=>{requireAdmin(actor);if(!actor.agency)throw forbidden()}
  api.get(recruitmentSetup,inStore(async(db,actor,req)=>{
    requireAgencyMaster(actor)
    const store=idOf(req,'store'),loc=await locationOf(db,store),features=await storeFeatures(db,store)
    return {revision:features.revision,eligible_at:loc.eligible_at,contract_active:loc.contract_active,
      auto_enabled:loc.auto_enabled,monthly_limit:loc.monthly_limit,process_enabled:automationForStore(cfg,store,actor.tenant_id),
      features:recruitmentSetupView(features)}
  }))
  api.patch(recruitmentSetup+'/features',inStore((db,actor,req)=>{
    requireAgencyMaster(actor)
    return saveRecruitmentSetup(db,actor,idOf(req,'store'),recruitmentSetupInput.parse(req.body))
  }))
  api.patch(recruitmentSetup+'/automation',inStore(async(db,actor,req)=>{
    requireAgencyMaster(actor)
    const settings=z.strictObject({revision,enabled:z.boolean(),contract:z.boolean(),
      monthly_limit:z.int().min(1).max(1000000),reason:text(200)}).parse(req.body)
    const store=idOf(req,'store')
    await lockDispatch(db,actor.tenant_id)
    // 既存の顧客・兼用LINEを自動配信対象へ切り替える権限までは委任しない。
    if(settings.enabled&&(await db.query("SELECT 1 FROM channel WHERE purpose<>'recruitment' LIMIT 1")).rowCount)throw forbidden()
    return updateAutomation(db,cfg,actor,store,settings)
  }))

  const scenarios = '/stores/:store/scenarios'
  const scenario = scenarios+'/:scenario'
  const scenarioContext = (db:DB,actor:Actor,req:Request) => ({db,actor,store:idOf(req,'store')})
  api.post(scenarios+'/media',express.raw({type:['image/jpeg','image/png'],limit:imageInputLimit,inflate:false}),inStore((db,actor,req)=>uploadStudioImage(db,cfg,actor,idOf(req,'store'),req.body),true,201))
  api.get(scenarios+'/media',inStore((db,actor,req)=>listStudioImages(db,cfg,idOf(req,'store'))))
  api.get(scenarios,inStore((db,actor,req)=>scenarioList(scenarioContext(db,actor,req),req.query.summary==='1')))
  api.post(scenarios,inStore((db,actor,req)=>createScenario(scenarioContext(db,actor,req),cfg,req,keyOf(req)),true,201))
  api.get(scenario,inStore((db,actor,req)=>scenarioDetail(scenarioContext(db,actor,req),idOf(req,'scenario'))))
  api.patch(scenario,inStore((db,actor,req)=>saveScenario(scenarioContext(db,actor,req),idOf(req,'scenario'),req.body)))
  api.patch(scenario+'/folder',inStore((db,actor,req)=>saveScenarioFolder(scenarioContext(db,actor,req),idOf(req,'scenario'),req.body)))
  api.get(scenario+'/metrics',inStore((db,actor,req)=>scenarioMetrics(scenarioContext(db,actor,req),idOf(req,'scenario'),req.query.version===undefined?undefined:z.coerce.number().int().positive().parse(req.query.version))))
  api.post(scenario+'/presence',inStore((db,actor,req)=>studioPresence(scenarioContext(db,actor,req),idOf(req,'scenario'),req.body)))
  api.get(scenario+'/readiness',inStore((db,actor,req)=>scenarioReadiness(scenarioContext(db,actor,req),cfg,idOf(req,'scenario'))))
  api.get(scenario+'/publication-review',inStore((db,actor,req)=>publicationReview(scenarioContext(db,actor,req),idOf(req,'scenario'))))
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
  api.get(moduleLink,inStore(async(_db,actor)=>{
    requireSupervisor(actor)
    return {configured:moduleConfigured(cfg)}
  }))
  api.post(moduleLink,inStore((db,actor,req)=>{
    requireSupervisor(actor)
    return beginModuleLink(db,cfg,actor,idOf(req,'store'),staffCredential(req)!,moduleStart.parse(req.body).purpose)
  }))
  api.post(moduleLink+'/complete',async(req,res)=>{
    const data=moduleReturn.parse(req.body),store=idOf(req,'store'),session=staffCredential(req)
    const authorized=async(db:DB)=>{
      const actor=await requestActor(db,req)
      requireSupervisor(actor)
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
    // エールの初回接続は採用用途のみ。ボットIDを手入力で確定せず、公式APIで
    // トークンとチャネルの実際の対応関係を確認してから登録する。
    if(actor.agency&&(data.purpose!=='recruitment'||data.bot_user_id))throw forbidden()
    const store = idOf(req,'store')
    return once(db,cfg,actor,'line.register',keyOf(req),{store,data},async()=>{
      const identity = data.bot_user_id ? {userId:data.bot_user_id,basicId:null} : await line.botIdentityForChannel(data.messaging_id,data)
      if (!identity) throw new Fault(422,'LINE_CHANNEL_TOKEN','Messaging APIのチャネルIDと、同じチャネルで発行したアクセストークンを確認してください。')
      const created=await createChannel(db,cfg,actor,store,{...data,bot_user_id:identity.userId,basic_id:identity.basicId})
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
        requireAgencyManualConnection(actor,c)
        if (c.module_channel_id && item==='webhook') throw new Fault(409,'LINE_MODULE_MANAGED','公式LINEへのテストメッセージで受信を確認してください。')
        if (c.revision !== required.revision) throw conflict()
        return { actor,c }
      }
      const { actor,c } = await tx(pool,read)
      if (!cfg.external) throw new Fault(409,'HTTPS_REQUIRED','公開HTTPS環境でLINE接続を確認してください。')
      await gate(pool,cfg,'line-check:'+item+':'+c.id,5)
      const cred = channelCredentials(cfg,c)
      const identity = item==='token' && !('module' in cred) && c.messaging_id
        ? await line.botIdentityForChannel(c.messaging_id,cred) : null
      const passed = item==='token' ? ('module' in cred ? await line.checkToken(c,cred) : identity?.userId===c.bot_user_id)
        : c.checks.token_verified && await line.checkWebhook(cred,cfg.origin+'/api/v1/webhooks/line/'+c.id)
      const response = await tx(pool,async db=>{
        await read(db)
        await lockDispatch(db,actor.tenant_id)
        const checks = { [item+'_verified']: !!passed, ...(item==='token' && !passed ? {webhook_verified:false} : {}) }
        const updated = await db.query(`UPDATE channel SET checks=checks || $2::jsonb,revision=revision+1,
          basic_id=coalesce($4,basic_id) WHERE id=$1 AND revision=$3 RETURNING id`,
          [c.id,JSON.stringify(checks),c.revision,passed&&identity?identity.basicId:null])
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
      FROM tester t LEFT JOIN test_send j ON j.tester_id=t.id AND j.scenario_id IS NULL AND j.source_id IS NULL
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
