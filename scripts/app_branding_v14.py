from pathlib import Path
from PIL import Image, ImageDraw
ROOT=Path(__file__).resolve().parents[1]; AS=ROOT/'icons'; AS.mkdir(exist_ok=True)
BG=(5,11,19); LIME=(191,221,62); GREEN=(122,183,52); INK=(239,243,246)
def icon(size):
    im=Image.new('RGB',(size,size),BG); d=ImageDraw.Draw(im); pad=int(size*.08); o=max(2,int(size*.012))
    d.rounded_rectangle((pad,pad,size-pad,size-pad),radius=int(size*.18),outline=(62,91,35),width=o)
    w=max(4,int(size*.028))
    d.arc((size*.22,size*.18,size*.78,size*.76),205,515,fill=INK,width=max(3,int(size*.018)))
    # speed trails
    for off in (0,.065,.13): d.line([(size*(.18+off),size*.68),(size*(.43+off),size*.47)],fill=GREEN,width=max(3,int(size*.018)))
    # tennis ball
    b=(size*.42,size*.28,size*.72,size*.58); d.ellipse(b,fill=(147,188,48),outline=LIME,width=max(3,int(size*.016)))
    d.arc((size*.44,size*.26,size*.61,size*.57),280,80,fill=INK,width=max(3,int(size*.014)))
    d.arc((size*.54,size*.29,size*.72,size*.60),100,260,fill=INK,width=max(3,int(size*.014)))
    return im
for s in (32,180,192,512):
    name='favicon-32' if s==32 else ('apple-touch-icon' if s==180 else f'icon-{s}')
    icon(s).save(AS/f'{name}.png',optimize=True)
(ROOT/'manifest.webmanifest').write_text('''{\n  "name":"Tennis Edge Pro",\n  "short_name":"TEP",\n  "start_url":"./",\n  "display":"standalone",\n  "background_color":"#050b13",\n  "theme_color":"#050b13",\n  "icons":[\n    {"src":"./icons/icon-192.png","sizes":"192x192","type":"image/png","purpose":"any maskable"},\n    {"src":"./icons/icon-512.png","sizes":"512x512","type":"image/png","purpose":"any maskable"}\n  ]\n}\n''',encoding='utf-8')
p=ROOT/'index.html'; s=p.read_text(encoding='utf-8')
links='''\n<link rel="manifest" href="manifest.webmanifest">\n<link rel="icon" type="image/png" sizes="32x32" href="icons/favicon-32.png">\n<link rel="apple-touch-icon" sizes="180x180" href="icons/apple-touch-icon.png">\n<meta name="apple-mobile-web-app-capable" content="yes">\n<meta name="apple-mobile-web-app-title" content="Tennis Edge Pro">'''
if 'apple-touch-icon' not in s:s=s.replace('</title>','</title>'+links,1)
if 'tep-brand-inline' not in s and '<div class="brand"><h1>' in s:
    s=s.replace('<div class="brand"><h1>','<div class="brand" style="display:flex;align-items:center;gap:9px"><img id="tep-brand-inline" src="icons/icon-192.png" alt="" width="34" height="34" style="border-radius:10px"><div><h1>',1)
    s=s.replace('</p></div><div class="status">','</p></div></div><div class="status">',1)
p.write_text(s,encoding='utf-8'); print('Tennis premium branding ready')