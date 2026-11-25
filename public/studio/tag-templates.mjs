import { starter } from './engine.mjs'

// Each template is original, editable recruitment correspondence. Only an actual
// tag selected from the current store's catalog is used as the trigger/guard.
const entry=(label,title,description,body,options={})=>Object.freeze({label,title,description,body,...options})
export const tagStepTemplates=Object.freeze({
  new_friend:entry('新規友だち','採用窓口のごあいさつ','通知に同意している新しい採用友だちへ、相談窓口を案内します。','友だち追加ありがとうございます。{{store}}の採用窓口です。\nお仕事内容や面談について気になることがあれば、このトークからお気軽にご相談ください。'),
  new_application:entry('新規応募','応募受付のお礼','応募フォームを受け付けたことを伝えます。面談予約の再案内は「面談未予約」のテンプレートに分けます。','{{store}}へご応募いただき、ありがとうございます。\nご入力いただいた内容をもとにご案内いたします。面談やお仕事内容についてご質問があれば、このトークへご連絡ください。'),
  unanswered:entry('未回答','応募入力のやさしい再案内','24時間後も未回答タグが残り、面談が未予約の場合だけ1通案内します。','{{store}}の採用窓口です。\nご応募をご検討中でしたら、こちらから応募・面談のご案内をご確認いただけます。ご不明点があればお気軽にお知らせください。',{wait:1440,booked:false,link:true,withoutLink:'{{store}}の採用窓口です。\nご応募をご検討中でしたら、応募方法や面談日程についてこのトークへお気軽にご相談ください。'}),
  in_progress:entry('対応中','確認中のご案内','担当者が対応を開始したときに、問い合わせ窓口を案内します。','{{store}}の採用窓口です。\nご連絡内容を確認しております。追加で確認したいことがございましたら、このトークへお知らせください。'),
  interview_pending:entry('面談未予約','空き面談枠のご案内','24時間待機し、面談未予約で対象タグが残っている人へ予約リンクを案内します。','{{store}}です。\n面談をご希望でしたら、受付中の空き枠からご都合のよい日時をお選びいただけます。ご案内はこちらです。',{wait:1440,booked:false,link:true,withoutLink:'{{store}}です。\n面談をご希望でしたら、ご都合のよい日時をこのトークへお知らせください。'}),
  interview_booked:entry('面談予約済','対面面談の準備案内','予約が確定している場合だけ、当日の確認事項を案内します。予約確定通知と重複しない補足メッセージです。','{{store}}です。\n対面面談に向け、場所や当日の持ち物について確認したいことがございましたら、このトークへご連絡ください。お会いできるのをお待ちしております。',{booked:true}),
  interview_done:entry('面談完了','面談後のお礼','面談後のお礼を伝え、追加の質問を受け付けます。','本日は{{store}}の面談にお越しいただきありがとうございました。\nお仕事内容や働き方について追加のご質問がございましたら、こちらからお気軽にご連絡ください。'),
  interview_cancelled:entry('キャンセル','再予約のご案内','キャンセルから1時間待機し、再予約が入っていない場合だけ再案内します。','{{store}}です。\nご都合が合うタイミングで、改めて面談をご希望でしたらこちらから空き枠をご確認いただけます。無理のない範囲でご利用ください。',{wait:60,booked:false,link:true,withoutLink:'{{store}}です。\n改めて面談をご希望でしたら、ご都合のよい日時をこのトークへお知らせください。無理のない範囲でご連絡ください。'}),
  trial_scheduled:entry('体験入店予定','体験入店に向けた確認','集合場所・準備物などを確認するための案内です。日時や持ち物は店舗ごとに異なるため断定しません。','{{store}}です。\n体験入店に向けて、集合場所や当日の準備について確認したい点はありませんか？ ご不明点があればこちらのトークへご連絡ください。'),
  trial_done:entry('体験入店済','体験入店のお礼','体験後のお礼と質問受付を伝えます。','{{store}}での体験入店にお越しいただき、ありがとうございました。\nご感想や今後について気になることがございましたら、お聞かせください。'),
  hired:entry('採用','採用後の手続き案内','採用後に必要な確認を担当者と進めるための文面です。契約条件や給与は断定しません。','{{store}}の採用担当です。\n今後のお手続きについて、担当者とご確認いただくためのご案内です。ご質問やご都合のよい連絡方法がありましたらお知らせください。'),
  joined:entry('入店済','入店後のフォロー','入店後の不明点や連絡方法を案内するための文面です。','{{store}}です。\nご入店後のお手続きや連絡方法について、ご不明点があればこのトークへご相談ください。'),
  withdrawn:entry('辞退・終了','採用フォローを終了する','辞退・終了のタグを持つ方への自動メッセージは送信しません。必要な場合だけ手動返信用の例文を利用してください。','',{manual:'ご連絡ありがとうございました。今後の採用に関するご案内は終了いたします。',silent:true}),
  waiting_reply:entry('返信待ち','返信待ちのフォロー','24時間後も返信待ちタグが残っている場合だけ、1通連絡します。返信を受けたら店舗側でタグを外す運用です。','{{store}}です。\n先日のご案内について、ご不明点やご都合の変更はございませんか？ お時間のあるときにご返信いただければ幸いです。',{wait:1440}),
  handoff:entry('店長対応中','店長対応中は自動配信しない','店長への引き継ぎ中は自動返信を追加しません。必要な場合だけLINE公式アカウントアプリから手動返信してください。','',{manual:'ご連絡ありがとうございます。担当者が直接ご案内いたします。ご不明点をお知らせください。',silent:true}),
  follow_up:entry('再連絡予定','再連絡・相談受付','24時間待機して、再連絡予定タグがまだある場合だけ1通案内します。','{{store}}の採用窓口です。\n先日のご連絡について、その後いかがでしょうか。ご都合やご質問がございましたら、お気軽にご連絡ください。',{wait:1440}),
  job_site:entry('求人サイト','求人情報からのご連絡','求人情報を見て連絡した方に、採用窓口を案内します。','求人情報をご覧いただきありがとうございます。{{store}}の採用窓口です。\n募集内容や対面面談について、ご質問があればこちらのトークへお知らせください。'),
  instagram:entry('Instagram','Instagram経由のご案内','Instagramから採用LINEへ来た方へのあいさつです。','Instagramからのご連絡ありがとうございます。{{store}}の採用窓口です。\n掲載内容や面談についてご質問がございましたら、お気軽にご相談ください。'),
  x:entry('X','X経由のご案内','Xから採用LINEへ来た方へのあいさつです。','Xからのご連絡ありがとうございます。{{store}}の採用窓口です。\nお仕事内容や面談のお問い合わせは、こちらのトークで承ります。'),
  referral:entry('紹介','紹介経由のご案内','紹介経由で相談した方へ案内します。紹介者名などの個人情報は含めません。','ご紹介を通じてご連絡いただき、ありがとうございます。{{store}}です。\n募集内容や面談について、気になることがございましたらお気軽にお知らせください。'),
  beginner:entry('未経験','初めての方向けのご案内','未経験の方に相談窓口を案内します。待遇や採用可否を保証しません。','{{store}}の採用窓口です。\n初めてのお仕事について不安な点や、事前に確認しておきたいことはございませんか？ 面談時にもご質問いただけますので、お気軽にご相談ください。'),
  experienced:entry('経験者','経験者向けのご案内','経験のある方から希望条件や質問を受け付ける文面です。','{{store}}の採用窓口です。\nこれまでのご経験や今後の働き方について、ご希望の条件・確認事項がございましたらお聞かせください。'),
  generic:entry('汎用','採用に関するご案内','任意のカスタムタグに使える文面です。タグ名自体は送信しません。','{{store}}の採用窓口です。\nご案内内容について気になる点や、今後のご希望がございましたらこのトークへお気軽にお知らせください。'),
})
export const recommendedTagTemplate=key=>Object.hasOwn(tagStepTemplates,key)?key:'generic'

export function buildTagTemplate({tag,pattern=recommendedTagTemplate(tag?.tag_key),channel='',mode='tag_added',activeKeys=[],withLink=true}) {
  if(!tag?.tag_key||!tag.label||tag.active===false)throw new Error('有効な採用タグを選択してください。')
  if(!Object.hasOwn(tagStepTemplates,pattern)||!['tag_added','tag_campaign'].includes(mode))throw new Error('テンプレートまたは開始条件を確認してください。')
  const template=tagStepTemplates[pattern],key=tag.tag_key
  const flow={...starter('recruitment'),name:(tag.label+' · '+template.title).slice(0,100),trigger:mode,channel,entry:'guard'}
  if(mode==='tag_added')flow.triggerTag=key
  const end={id:'end',type:'end',name:template.silent?'自動送信せず終了':'配信終了'}
  if(template.silent){flow.entry='end';flow.nodes=[end];return flow}
  const exclude=['withdrawn','handoff'].filter(k=>k!==key&&activeKeys.includes(k))
  const message={id:'message',type:'message',name:template.title,category:'service',body:template.link&&!withLink?template.withoutLink:template.body+(template.link&&withLink?'\n{{interview_link}}':''),next:'end',
    tagGuard:{tag:key,exclude,...(typeof template.booked==='boolean'?{booked:template.booked}:{})}}
  const nodes=[]
  const first=template.wait?'wait':exclude.length?'exclude-0':typeof template.booked==='boolean'?'booking':'message'
  nodes.push({id:'guard',type:'branch',name:'対象タグが付いているか',condition:'tag',tag:key,yes:first,no:'end'})
  if(template.wait){
    nodes.push({id:'wait',type:'wait',name:template.wait===1440?'24時間待機':template.wait+'分待機',mode:'delay',minutes:template.wait,next:'guard-after-wait'},
      {id:'guard-after-wait',type:'branch',name:'待機後も対象タグがあるか',condition:'tag',tag:key,yes:exclude.length?'exclude-0':typeof template.booked==='boolean'?'booking':'message',no:'end'})
  }
  exclude.forEach((tag,i)=>nodes.push({id:'exclude-'+i,type:'branch',name:tag==='withdrawn'?'辞退・終了の確認':'店長対応中の確認',condition:'tag',tag,yes:'end',no:i+1<exclude.length?'exclude-'+(i+1):typeof template.booked==='boolean'?'booking':'message'}))
  if(typeof template.booked==='boolean')nodes.push({id:'booking',type:'branch',name:'現在の面談予約を確認',condition:'booked',yes:template.booked?'message':'end',no:template.booked?'end':'message'})
  nodes.push(message,end);flow.nodes=nodes;return flow
}
