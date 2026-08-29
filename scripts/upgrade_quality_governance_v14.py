from pathlib import Path
p=Path('index.html')
s=p.read_text(encoding='utf-8')
tag='<script src="tennis-quality-governance-v14.js?v=14.0"></script>'
if tag not in s:
    marker='</body>'
    if marker not in s: raise SystemExit('missing </body>')
    s=s.replace(marker,tag+'\n'+marker,1)
p.write_text(s,encoding='utf-8')
