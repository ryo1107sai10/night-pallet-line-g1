// A step card's position is its actual graph connection, not its array index.
// Keep branches, terminal nodes and joins as route boundaries: reordering a
// linear segment must never accidentally move a message to another condition.
const linear = step => !!step && !['branch','end'].includes(step.type) && typeof step.next === 'string'
const outgoing = step => step.type === 'branch' ? ['yes','no'] : linear(step) ? ['next'] : []

function topology(flow) {
  const steps = new Map(flow.nodes.map(step => [step.id,step]))
  if (steps.size !== flow.nodes.length) return null
  const incoming = new Map(flow.nodes.map(step => [step.id,[]]))
  incoming.get(flow.entry)?.push({owner:null,key:'entry'})
  for (const step of flow.nodes) for (const key of outgoing(step)) {
    incoming.get(step[key])?.push({owner:step.id,key})
  }
  const reachable = new Set(), visiting = new Set()
  let cyclic = false
  function visit(id) {
    if (visiting.has(id)) {cyclic = true;return}
    if (!steps.has(id) || reachable.has(id)) return
    visiting.add(id)
    const step = steps.get(id)
    for (const key of outgoing(step)) visit(step[key])
    visiting.delete(id)
    reachable.add(id)
  }
  visit(flow.entry)
  return cyclic ? null : {steps,incoming,reachable}
}

// All cards in one group have the same conditions for reaching them. A join
// may start a shared group, but it cannot belong to one of its incoming lanes.
export function reorderGroups(flow) {
  const groups = new Map()
  const graph = topology(flow)
  if (!graph) return groups
  const {steps,incoming,reachable} = graph
  for (const step of flow.nodes) {
    if (!reachable.has(step.id) || !linear(step)) continue
    const parents = incoming.get(step.id)
    if (parents.length === 1 && parents[0].owner !== null && linear(steps.get(parents[0].owner))) continue
    const group = [step.id]
    let current = step
    while (linear(steps.get(current.next)) && incoming.get(current.next).length === 1 && !group.includes(current.next)) {
      current = steps.get(current.next)
      group.push(current.id)
    }
    for (const id of group) groups.set(id,group)
  }
  return groups
}

// Return a new draft only for a meaningful, safe move. Published versions are
// separate immutable records; the caller still uses the normal save/publish UI.
export function reorderStep(flow,sourceId,targetId,position) {
  if (sourceId === targetId || !['before','after'].includes(position)) return null
  const group = reorderGroups(flow).get(sourceId)
  if (!group?.includes(targetId)) return null
  const order = group.filter(id => id !== sourceId)
  order.splice(order.indexOf(targetId) + (position === 'after' ? 1 : 0),0,sourceId)
  if (order.every((id,index) => id === group[index])) return null
  const draft = structuredClone(flow)
  const {steps,incoming} = topology(draft)
  const first = group[0], tail = steps.get(group.at(-1)).next
  for (const ref of incoming.get(first)) {
    if (ref.owner===null) draft.entry=order[0]
    else steps.get(ref.owner)[ref.key]=order[0]
  }
  for (let i=0;i<order.length;i++) steps.get(order[i]).next=order[i+1]??tail
  // Keep the sidebar/version listing in the same order, too, without changing
  // the relative position or identity of cards from any other route.
  const ids = new Set(group)
  let index = 0
  draft.nodes = draft.nodes.map(step => ids.has(step.id) ? steps.get(order[index++]) : step)
  return draft
}

export function adjacentMove(flow,id,direction) {
  const group = reorderGroups(flow).get(id)
  if (!group || ![-1,1].includes(direction)) return null
  const target = group[group.indexOf(id)+direction]
  return target ? reorderStep(flow,id,target,direction<0?'before':'after') : null
}
