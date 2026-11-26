#!/usr/bin/env python3
"""Build an authenticated release asset, never a public/static PDF. No external AI or live account data."""
import argparse, datetime, hashlib, json, os, re, subprocess
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
SOURCE=ROOT/'docs/manual/operation-manual.json'

def read_source():
    raw=SOURCE.read_text(encoding='utf-8'); source=json.loads(raw)
    if sum(s['count'] for s in source['sections'])!=len(source['pages']): raise ValueError('Manual contents and sections differ')
    if not 1<=len(source['pages'])<=39: raise ValueError('Manual page count out of range')
    if re.search(r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}', raw): raise ValueError('Do not include individual account addresses')
    for name, labels in source['ui_labels'].items():
        path=(ROOT/name).resolve()
        if not path.is_relative_to(ROOT/'public'): raise ValueError('UI reference must be a public source file')
        contents=path.read_text(encoding='utf-8')
        for label in labels:
            if label not in contents: raise ValueError(f'Update manual wording: {name}: {label}')
    return source

def source_version():
    h=hashlib.sha256()
    paths=[SOURCE,Path(__file__),ROOT/'package.json',ROOT/'package-lock.json',ROOT/'tsconfig.json',ROOT/'Dockerfile']
    for name in ('src','public','db'): paths.extend(p for p in (ROOT/name).rglob('*') if p.is_file())
    for path in sorted(paths):
        h.update(str(path.relative_to(ROOT)).encode('utf-8')+b'\0'); h.update(path.read_bytes());h.update(b'\0')
    return h.hexdigest()[:12]

def build(source,out,fontpath):
    from reportlab.pdfgen import canvas
    from reportlab.lib.colors import HexColor
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    font='ManualJP';pdfmetrics.registerFont(TTFont(font,str(fontpath)))
    version=source_version(); timestamp=datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
    date=timestamp.astimezone(datetime.timezone(datetime.timedelta(hours=9))).strftime('%Y.%m.%d')
    out.mkdir(parents=True,exist_ok=True)
    # Generate into a staging dir, then atomically replace files. No live web-request rendering.
    import tempfile,shutil
    with tempfile.TemporaryDirectory(prefix='manual-build-',dir=out.parent) as scratch:
        temp=Path(scratch); pdf=temp/'operation-manual.pdf'
        c=canvas.Canvas(str(pdf),pagesize=A4);c.setTitle(source['title']);c.setAuthor('Night PRO LINE')
        W,H=A4;M=42;CW=W-2*M;N=len(source['pages'])+1
        navy='#152039';mint='#B8F0D8';purple='#624294';muted='#52617A';gray='#DEE4ED';green='#087451';lavender='#F0EDF7'
        def color(v): c.setFillColor(HexColor(v))
        def text(x,y,t,size=11,col=navy,align='left'):
            color(col);c.setFont(font,size);(c.drawRightString if align=='right' else c.drawString)(x,y,t)
        def box(x,y,w,h,col,rad=0):
            color(col);(c.roundRect(x,y,w,h,rad,stroke=0,fill=1) if rad else c.rect(x,y,w,h,stroke=0,fill=1))
        def wrap(s,w,size):
            result=[]
            for par in s.split('\n'):
                current=''
                for ch in par:
                    if current and pdfmetrics.stringWidth(current+ch,font,size)>w:
                        # Avoid leading Japanese closing punctuation.
                        if ch in '、。）」』】？！':
                            result.append(current[:-1]);current=current[-1]+ch
                        else:result.append(current);current=ch
                    else: current+=ch
                result.append(current)
            return result
        def para(s,x,y,w,size=10.7,lead=16,col=muted):
            for line in wrap(s,w,size): text(x,y,line,size,col);y-=lead
            return y
        def button(y,label,url):
            if not url.startswith('https://'):raise ValueError('Only HTTPS manual links')
            box(M,y-29,CW,29,'#EAF5F1',6);text(M+10,y-18,label,10.6,green)
            c.linkURL(url,(M,y-29,W-M,y),relative=0,thickness=0);return y-38
        c.bookmarkPage('cover');c.addOutlineEntry('目次','cover',0,False)
        box(0,0,W,H,navy);text(M,H-49,date+'  公開版  '+version,11,mint);text(M,H-103,'Night PRO LINE',30,mint);text(M,H-154,'総合操作マニュアル',28,'#FFFFFF')
        para('監督者・管理会社・店舗の説明書、店舗導入・ピヨ丸・動画案内を収録。アプリの公開版と同じ内容の教材を自動で生成しています。',M,H-186,CW,12,20,'#D8E3F4')
        box(M,170,CW,374,'#F8FAFC',12);text(M+18,518,'目次',18);text(M+18,495,'項目を押すと該当ページへ移動します。',10,muted)
        start=2
        for i,section in enumerate(source['sections']):
            y=464-59*i;end=start+section['count']-1
            box(M+18,y-15,25,25,'#EDE8F7',6);text(M+23,y-7,f'{i+1:02d}',10,purple)
            text(M+54,y+3,section['title'],12.5);text(M+54,y-15,section['description'],9.4,muted)
            text(W-M-18,y+3,f'{start} - {end}' if end!=start else str(start),10,purple,'right')
            c.linkRect('',f'page-{start}',(M+14,y-24,W-M-14,y+21),relative=0,thickness=0)
            start=end+1
        text(M,135,'アプリ更新時に再生成する最新版・自動更新',11,mint)
        para('個人の登録メール、パスワード・認証キー・招待コードは記載していません。ログインはそれぞれ本人の正式なアカウントで行ってください。',M,107,CW,10,15,'#D8E3F4')
        text(W-M,28,'1 / '+str(N),9,'#D8E3F4','right');c.showPage()
        starts={};pn=2
        for s in source['sections']:starts[pn]=s['title'];pn+=s['count']
        for pn,p in enumerate(source['pages'],2):
            c.bookmarkPage(f'page-{pn}')
            if pn in starts:c.addOutlineEntry(starts[pn],f'page-{pn}',0,False)
            box(0,H-70,W,70,navy);text(M,H-29,'Night PRO LINE',18,mint);text(M,H-51,p['section'],10,'#FFFFFF');text(M,H-113,p['title'],23)
            y=para(p['lead'],M,H-140,CW,11,17)-13;counter=0
            for i,b in enumerate(p['blocks']):
                k=b['kind'];title=b['title'];body=b.get('text','')
                if k=='heading':
                    text(M,y,title,13,purple);y-=24;counter=0
                elif k=='link':y=button(y,title,b['url'])
                elif k=='field':
                    box(M,y-20,CW,22,'#F2F4F8' if i%2 else '#FFFFFF',2);text(M+9,y-12,title,10,muted);text(M+180,y-12,body,10);y-=25
                elif k=='step':
                    counter+=1;box(M,y-8,17,17,purple,8);text(M+4.8,y-3,str(counter),10,'#FFFFFF');text(M+27,y,title,12.4)
                    y=para(body,M+27,y-19,CW-27,10.5,16)-11
                elif k=='note':
                    count=len(wrap(body,CW-24,10.2));height=35+count*15
                    box(M,y-height,CW,height,lavender,8);text(M+12,y-18,title,11.5,purple);para(body,M+12,y-34,CW-24,10.2,15,navy);y-=height+9
                elif k=='paragraph' or k=='text':
                    text(M,y,title,13,purple);y=para(body,M,y-20,CW,10.5,16)-13
                elif k=='timeline':
                    box(M,y-29,CW,37,'#F2F4F8' if i%2==0 else '#FFFFFF',5);text(M+10,y-4,b['time'],10.5,purple);text(M+66,y-4,title,10.7);text(M+66,y-19,body,9.5,muted);y-=39
                else:raise ValueError('Unknown manual block '+k)
                if y<48:raise ValueError(f'Manual page {pn} is too long; split into another page.')
            c.setStrokeColor(HexColor(gray));c.line(M,42,W-M,42);text(M,24,date+' | 公開版 '+version,9,muted);text(W-M,24,f'{pn} / {N}',9,muted,'right');c.showPage()
        c.save()
        # Render every page, verify the exact complete count before making the assets available.
        subprocess.run(['pdftoppm','-jpeg','-r','110','-scale-to','1500',str(pdf),str(temp/'page')],check=True,timeout=90,capture_output=True)
        previews=sorted(temp.glob('page-*.jpg'),key=lambda p:int(p.stem.split('-')[-1]))
        if len(previews)!=N or pdf.stat().st_size>8*1024*1024 or any(p.stat().st_size<1000 for p in previews):raise ValueError('Manual PDF or preview invalid')
        for n,p in enumerate(previews,1): shutil.move(p,temp/f'operation-manual-p{n}.jpg')
        manifest={'version':version,'updated_at':timestamp.isoformat(),'pages':N,'sha256':hashlib.sha256(pdf.read_bytes()).hexdigest()}
        (temp/'manifest.json').write_text(json.dumps(manifest)+'\n')
        for name in ['operation-manual.pdf',*[f'operation-manual-p{i}.jpg' for i in range(1,N+1)],'manifest.json']:
            os.replace(temp/name,out/name)
    print(f'Operation manual {version}: {N} pages generated and rendered.')

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--check-only',action='store_true');parser.add_argument('--output',type=Path,default=ROOT/'manual-generated');parser.add_argument('--font',type=Path,default=Path(os.environ.get('MANUAL_JP_FONT','/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf')))
    args=parser.parse_args();source=read_source()
    if args.check_only: print('Manual source and UI references verified.')
    else: build(source,args.output,args.font)
