import {clockLabel, interval, timeOptions} from './hours.mjs'

export function configureHours(form,hours){
  const {start,end}=form.elements
  start.replaceChildren(...timeOptions(0,1440).map(value=>new Option(clockLabel(value),String(value))))
  start.value=String(hours.start)
  const showEnds=preferred=>{
    const options=timeOptions(Number(start.value)+interval,1440,true)
    end.replaceChildren(...options.map(value=>new Option(clockLabel(value),String(value))))
    end.value=String(options.includes(preferred)?preferred:options.at(-1))
  }
  showEnds(hours.end)
  start.onchange=()=>showEnds(Number(end.value))
}
