import codecs
with codecs.open(r"E:\MyCodes\Mox\apps\web\src\views\MiscViews.tsx", "r", "utf-8") as f:
    text = f.read()

text = text.replace('<span>A</span>', '<span>&middot;</span>')
text = text.replace('<span>A</span>', '<span>&middot;</span>')
text = text.replace('A', '&middot;')
text = text.replace('-?', 'O')
text = text.replace('dY-', 'O')
text = text.replace('+\'', '&rarr;')
text = text.replace('o"', '&check;')

with codecs.open(r"E:\MyCodes\Mox\apps\web\src\views\MiscViews.tsx", "w", "utf-8") as f:
    f.write(text)
