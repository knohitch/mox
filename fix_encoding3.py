with open(r"E:\MyCodes\Mox\apps\web\src\views\MiscViews.tsx", "rb") as f:
    text = f.read().decode('utf-8', errors='ignore')

text = text.replace('Â·', '&middot;')
text = text.replace('—', '&mdash;')
text = text.replace('?', '&rarr;')
text = text.replace('?', '&check;')
text = text.replace('?', '&bull;')

with open(r"E:\MyCodes\Mox\apps\web\src\views\MiscViews.tsx", "w", encoding="utf-8") as f:
    f.write(text)
