#!/usr/bin/env python3
# Stimulus/layout scan over a folder of teacher PDFs (E5 design, 2026-09-01).
#
# For each PDF: pages, numbered items (blank-prefix aware: "______ 1)"),
# raster figures and how many items follow each one on the same page before
# the next figure (shared by 2+ items / used by one / sitting after an item,
# e.g. an answer grid / orphan), figures >=35% of page height, long text
# blocks that look like passages, "questions 4-6" phrasing, two-column pages,
# and the candidate count the import pipeline extracted (read from
# <samples>/import-run/gallery.html when present).
#
# Usage:  python3 docs/scripts/stimulus-scan.py design-tool/samples
# Needs PyMuPDF (python3 -c "import fitz"). Heuristic: item numbering by
# regex, attribution by vertical position - spot-check before quoting.
# Findings for the 2026-09-01 sample set: docs/stimulus-design.md.

import fitz, glob, re, sys, html
PREFIX = re.compile(r"^[\s_​\-•]*")
ITEM = re.compile(r"^\(?(\d{1,2})\s*[.):]\s*")
SUB  = re.compile(r"^\(?(\d{1,2})\s*[a-e]\s*[.):]\s*")
DIRECTIVE = re.compile(r"(questions?\s+\d+\s*(?:-|–|to|through)\s*\d+|use the (?:graph|table|figure|diagram|chart|data|passage|image|map|picture)|based on the (?:graph|table|figure|diagram|chart|data|passage|reading|information)|refer(?:ring)? to|the (?:graph|table|figure|diagram|chart|data|passage) (?:below|above)|read the (?:passage|following|excerpt|text)|following (?:passage|graph|table|figure|diagram|data|information))", re.I)
NAME_RE = re.compile(r"\bname\s*[:_]", re.I)
import os
gp = os.path.join(sys.argv[1], "import-run", "gallery.html")
gal = open(gp).read() if os.path.exists(gp) else ""
sections = re.split(r"<h2>", gal)[1:]
gal_counts = {}
for s in sections:
    title = html.unescape(re.match(r"(.*?)</h2>", s).group(1)).strip()
    gal_counts[title[:30]] = len(re.findall(r'class="cand"', s))

def lines_of(page):
    out=[]
    for b in page.get_text("dict")["blocks"]:
        if b.get("type")!=0: continue
        for l in b["lines"]:
            t="".join(s["text"] for s in l["spans"]).strip()
            if t: out.append((l["bbox"][1], l["bbox"][0], t))
    out.sort(); return out

hdr=f"{'pdf':30} {'pg':>2} {'items':>5} {'extr':>4} {'figs':>4} {'big':>3} {'fig>=2':>6} {'fig=1':>5} {'after':>5} {'orph':>4} {'para':>4} {'p>=2':>4} {'p=1':>3} {'range':>5} {'2col':>4}"
print(hdr); T=[0]*14
for path in sorted(glob.glob(sys.argv[1]+"/*.pdf")):
    doc=fitz.open(path); name=path.split("/")[-1]
    items=[]; figs=[]; paras=[]; ranges=0; twocol=0
    for pno,page in enumerate(doc):
        H=page.rect.height; W=page.rect.width
        seen=set(); xs=[]
        for y,x,t in lines_of(page):
            core=PREFIX.sub("", t)
            m=SUB.match(core) or ITEM.match(core)
            if m and len(core) > len(m.group(0)):
                key=(pno,m.group(1),bool(SUB.match(core)))
                if key not in seen: seen.add(key); items.append((pno,y,core[:30])); xs.append(x)
            if re.search(r"questions?\s+\d+\s*(?:-|–|to|through)\s*\d+", t, re.I): ranges+=1
        if xs and sum(1 for x in xs if x > W*0.45) >= 2 and sum(1 for x in xs if x < W*0.45) >= 2: twocol+=1
        for b in page.get_text("blocks"):
            if b[6]!=0: continue
            t=b[4].strip()
            if not t: continue
            core=PREFIX.sub("", t.splitlines()[0])
            if len(t)>220 and not (ITEM.match(core) or SUB.match(core)): paras.append((pno,b[1],len(t)))
        for img in page.get_images(full=True):
            for r in page.get_image_rects(img[0]):
                if r.width>40 and r.height>40: figs.append((pno,r,r.height/H))
    def followers(pno,y0,stops):
        cutoff=min([o for o in stops if o>y0],default=1e9)
        return [it for it in items if it[0]==pno and y0<=it[1]<cutoff]
    f2=f1=fa=f0=0
    for pno,r,frac in figs:
        n=len(followers(pno,r.y0,[o[1].y0 for o in figs if o[0]==pno]))
        above=[it for it in items if it[0]==pno and it[1]<r.y0]
        if n>=2: f2+=1
        elif n==1: f1+=1
        elif above: fa+=1
        else: f0+=1
    p2=p1=0
    for pno,y,_ in paras:
        n=len(followers(pno,y,[o[1] for o in paras if o[0]==pno]+[o[1].y0 for o in figs if o[0]==pno]))
        p2+= n>=2; p1+= n==1
    big=sum(1 for _,_,frac in figs if frac>=0.35)
    row=[len(doc),len(items),gal_counts.get(name[:30],0),len(figs),big,f2,f1,fa,f0,len(paras),p2,p1,ranges,twocol]
    T=[a+b for a,b in zip(T,row)]
    print(f"{name[:30]:30} "+" ".join(f"{v:>{w}}" for v,w in zip(row,[2,5,4,4,3,6,5,5,4,4,4,3,5,4])))
print(f"{'TOTAL':30} "+" ".join(f"{v:>{w}}" for v,w in zip(T,[2,5,4,4,3,6,5,5,4,4,4,3,5,4])))
