from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
p=ROOT/'index.html'; s=p.read_text(encoding='utf-8')
links='''\n<link rel="manifest" href="manifest.webmanifest">\n<link rel="icon" type="image/png" sizes="192x192" href="icons/icon-192.png">\n<link rel="apple-touch-icon" sizes="192x192" href="icons/icon-192.png">\n<meta name="apple-mobile-web-app-capable" content="yes">\n<meta name="apple-mobile-web-app-title" content="Tennis Edge Pro">'''
if 'apple-touch-icon' not in s:s=s.replace('</title>','</title>'+links,1)
# use the same visual identity in the top brand if not already present
candidates=['<div class="brand">','<div class="brand"><h1>']
if 'tep-brand-inline' not in s:
    if '<div class="brand"><h1>' in s:
        s=s.replace('<div class="brand"><h1>','<div class="brand" style="display:flex;align-items:center;gap:9px"><img id="tep-brand-inline" src="icons/icon-192.png" alt="" width="34" height="34" style="border-radius:10px"><div><h1>',1)
        s=s.replace('</p></div><div class="status">','</p></div></div><div class="status">',1)
p.write_text(s,encoding='utf-8')
print('Tennis branding wired')
