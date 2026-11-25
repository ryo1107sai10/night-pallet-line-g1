const HOLD_MS=320
const SLOP=10
const cardSelector='[data-step-id][data-reorderable]'
let suppressClickUntil=0

// A short tap still edits the card; a hold starts a sort. Mouse drags may
// also start immediately after intentional movement. Touch swipes before a
// hold remain normal page scrolling, including on narrow mobile screens.
export function installStepDrag(board,{groups,canMove,onMove}) {
  let drag=null
  function cardFor(target) {
    const card=target instanceof Element?target.closest(cardSelector):null
    return card&&board.contains(card)?card:null
  }
  function cleanup() {
    const d=drag
    if(!d)return
    drag=null
    clearTimeout(d.timer)
    cancelAnimationFrame(d.frame)
    d.controller.abort()
    d.card.classList.remove('drag-origin')
    d.target?.classList.remove('drop-before','drop-after')
    d.ghost?.remove()
    board.classList.remove('sorting-steps')
    if(d.active)suppressClickUntil=performance.now()+350
  }
  function locate(x,y) {
    const d=drag
    if(!d?.active)return
    const rect=board.getBoundingClientRect()
    const sourceRect=d.card.getBoundingClientRect()
    const overSource=x>=sourceRect.left&&x<=sourceRect.right&&y>=sourceRect.top&&y<=sourceRect.bottom
    let target=null,position=null,distance=Infinity
    if(!overSource&&x>=rect.left-8&&x<=rect.right+8&&y>=rect.top-14&&y<=rect.bottom+14) {
      for(const card of board.querySelectorAll(cardSelector)) {
        if(card===d.card||!d.group.includes(card.dataset.stepId))continue
        const r=card.getBoundingClientRect()
        if(x<r.left-16||x>r.right+16||y<r.top-24||y>r.bottom+24)continue
        const side=y<(r.top+r.bottom)/2?'before':'after'
        const from=d.group.indexOf(d.card.dataset.stepId),to=d.group.indexOf(card.dataset.stepId)
        if(side==='before'&&from===to-1||side==='after'&&from===to+1)continue
        const score=Math.abs(y-(r.top+r.bottom)/2)
        if(score<distance){target=card;distance=score;position=side}
      }
    }
    if(d.target!==target||d.position!==position) {
      d.target?.classList.remove('drop-before','drop-after')
      d.target=target;d.position=position
      target?.classList.add('drop-'+position)
    }
  }
  function positionGhost(x,y) {
    const d=drag
    if(!d?.active)return
    d.ghost.style.left=Math.max(0,Math.min(innerWidth-d.width,x-d.offsetX))+'px'
    d.ghost.style.top=y-d.offsetY+'px'
    locate(x,y)
  }
  function scrollFrame() {
    const d=drag
    if(!d?.active)return
    if(!board.isConnected||!canMove()){cleanup();return}
    const edge=Math.min(90,innerHeight/5)
    const delta=d.y<edge?-Math.min(18,(edge-d.y)/4):d.y>innerHeight-edge?Math.min(18,(d.y-innerHeight+edge)/4):0
    const scroller=board.closest('.canvas-scroll')
    const rect=scroller?.getBoundingClientRect()
    if(scroller&&rect&&scroller.scrollHeight>scroller.clientHeight+1){
      const edgeY=Math.min(80,rect.height/5),edgeX=Math.min(70,rect.width/5)
      const dy=d.y<rect.top+edgeY?-Math.min(18,(rect.top+edgeY-d.y)/4):d.y>rect.bottom-edgeY?Math.min(18,(d.y-rect.bottom+edgeY)/4):0
      const dx=d.x<rect.left+edgeX?-Math.min(18,(rect.left+edgeX-d.x)/4):d.x>rect.right-edgeX?Math.min(18,(d.x-rect.right+edgeX)/4):0
      if(dx||dy){scroller.scrollBy(dx,dy);locate(d.x,d.y)}
    }else if(delta){window.scrollBy(0,delta);locate(d.x,d.y)}

    d.frame=requestAnimationFrame(scrollFrame)
  }
  function activate() {
    const d=drag
    if(!d||d.active)return
    if(!d.card.isConnected||!canMove()){cleanup();return}
    d.active=true
    clearTimeout(d.timer)
    const r=d.card.getBoundingClientRect()
    d.width=r.width
    d.offsetX=Math.max(0,Math.min(r.width,d.startX-r.left))
    d.offsetY=Math.max(0,Math.min(r.height,d.startY-r.top))
    const ghost=d.card.cloneNode(true)
    ghost.removeAttribute('id')
    ghost.removeAttribute('data-step-id')
    ghost.removeAttribute('data-reorderable')
    ghost.classList.add('step-floating')
    ghost.setAttribute('aria-hidden','true')
    ghost.tabIndex=-1
    ghost.style.width=r.width+'px'
    ghost.style.height=r.height+'px'
    d.ghost=ghost
    document.body.append(ghost)
    d.card.classList.add('drag-origin')
    board.classList.add('sorting-steps')
    positionGhost(d.x,d.y)
    d.frame=requestAnimationFrame(scrollFrame)
  }
  function begin(card,x,y,kind,id) {
    if(drag||!canMove())return false
    const group=groups.get(card.dataset.stepId)
    if(!group||group.length<2)return false
    const controller=new AbortController()
    drag={card,group,kind,id,startX:x,startY:y,x,y,controller,active:false,timer:setTimeout(activate,HOLD_MS)}
    const {signal}=controller
    window.addEventListener('blur',cleanup,{signal})
    document.addEventListener('keydown',event=>{
      if(event.key==='Escape'&&drag){if(drag.active)event.preventDefault();cleanup()}
    },{signal})
    return true
  }
  function track(x,y,mouse=false) {
    const d=drag
    if(!d)return
    d.x=x;d.y=y
    if(!d.active&&Math.hypot(x-d.startX,y-d.startY)>SLOP) {
      if(mouse)activate()
      else {cleanup();return}
    }
    if(drag?.active)positionGhost(x,y)
  }
  function release(x,y) {
    const d=drag
    if(!d)return
    if(d.active)positionGhost(x,y)
    const move=d.active&&d.target?[d.card.dataset.stepId,d.target.dataset.stepId,d.position]:null
    cleanup()
    if(move&&canMove())onMove(...move)
  }
  board.addEventListener('pointerdown',event=>{
    if(event.pointerType==='touch'||event.button!==0||!event.isPrimary)return
    const card=cardFor(event.target)
    if(!card||!begin(card,event.clientX,event.clientY,event.pointerType,event.pointerId))return
    const {signal}=drag.controller
    document.addEventListener('pointermove',move=>{
      if(move.pointerId!==drag?.id)return
      track(move.clientX,move.clientY,move.pointerType==='mouse')
      if(drag?.active)move.preventDefault()
    },{signal,passive:false})
    document.addEventListener('pointerup',up=>{
      if(up.pointerId!==drag?.id)return
      if(drag.active)up.preventDefault()
      release(up.clientX,up.clientY)
    },{signal})
    document.addEventListener('pointercancel',event=>{if(event.pointerId===drag?.id)cleanup()},{signal})
  })
  board.addEventListener('touchstart',event=>{
    const card=cardFor(event.target)
    if(!card||event.touches.length!==1)return
    const finger=event.changedTouches[0]
    if(!begin(card,finger.clientX,finger.clientY,'touch',finger.identifier))return
    const {signal}=drag.controller
    const find=touches=>Array.from(touches).find(item=>item.identifier===drag?.id)
    document.addEventListener('touchstart',event=>{if(event.touches.length>1)cleanup()},{signal,passive:true})
    document.addEventListener('touchmove',move=>{
      const finger=find(move.touches)
      if(!finger)return
      if(drag.active&&move.cancelable)move.preventDefault()
      track(finger.clientX,finger.clientY)
    },{signal,passive:false})
    document.addEventListener('touchend',up=>{
      const finger=find(up.changedTouches)
      if(!finger)return
      if(drag.active&&up.cancelable)up.preventDefault()
      release(finger.clientX,finger.clientY)
    },{signal,passive:false})
    document.addEventListener('touchcancel',event=>{if(find(event.changedTouches))cleanup()},{signal})
  },{passive:true})
  board.addEventListener('contextmenu',event=>{if(cardFor(event.target)&&drag)event.preventDefault()})
  board.addEventListener('dragstart',event=>{if(cardFor(event.target))event.preventDefault()})
  board.addEventListener('click',event=>{
    if(event.detail>0&&cardFor(event.target)&&(drag?.active||performance.now()<suppressClickUntil)){
      event.preventDefault();event.stopImmediatePropagation()
    }
  },true)
}
