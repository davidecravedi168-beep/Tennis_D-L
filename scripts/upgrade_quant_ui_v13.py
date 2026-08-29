from pathlib import Path

p=Path('index.html')
s=p.read_text(encoding='utf-8')
marker='<script src="tennis-quant-math-v13.js?v=13.0"></script>\n<script src="tennis-quant-lab-v13.js?v=13.0"></script>'
if marker not in s:
    if '</body>' not in s:
        raise SystemExit('index.html missing </body>')
    s=s.replace('</body>',marker+'\n</body>')
    p.write_text(s,encoding='utf-8')
    print('Tennis V13 quant UI scripts injected')
else:
    print('Tennis V13 quant UI already present')
