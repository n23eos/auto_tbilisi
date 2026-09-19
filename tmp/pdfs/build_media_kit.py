from reportlab.lib.pagesizes import landscape, A4
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor, Color
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.utils import ImageReader
from PIL import Image
import os

OUT = "/Users/nickeo23/code_projects/web/autoschool_tbilisi/output/pdf/formula1-driving-school-media-kit.pdf"
IMG = "/Users/nickeo23/code_projects/web/autoschool_tbilisi/media/tbilisi-wide.png"
FONT = "/Users/nickeo23/Library/Fonts/Inter-VariableFont_slnt,wght.ttf"

W, H = landscape(A4)
NAVY = HexColor("#10243E")
BLUE = HexColor("#1D65A6")
SKY = HexColor("#DCECF7")
ORANGE = HexColor("#F0A229")
CREAM = HexColor("#F7F2E8")
INK = HexColor("#18212B")
MUTED = HexColor("#66717D")
WHITE = HexColor("#FFFFFF")

os.makedirs(os.path.dirname(OUT), exist_ok=True)
pdfmetrics.registerFont(TTFont("Inter", FONT))
pdfmetrics.registerFont(TTFont("InterBold", FONT))

c = canvas.Canvas(OUT, pagesize=(W, H))
c.setTitle("Formula 1 Driving School Media Kit")
c.setAuthor("Formula 1 Driving School, Tbilisi")

def txt(text, x, y, size=12, color=INK, font="Inter", max_width=None):
    c.setFont(font, size)
    c.setFillColor(color)
    if max_width is None:
        c.drawString(x, y, text)
        return
    words = text.split()
    line = ""
    yy = y
    for word in words:
        test = (line + " " + word).strip()
        if c.stringWidth(test, font, size) <= max_width:
            line = test
        else:
            c.drawString(x, yy, line)
            yy -= size * 1.35
            line = word
    if line:
        c.drawString(x, yy, line)

def footer(page):
    c.setStrokeColor(Color(1,1,1,0.16) if page == 1 else HexColor("#D9DEE5"))
    c.line(44, 28, W-44, 28)
    txt("Formula 1 Driving School, Tbilisi", 44, 13, 7.5, WHITE if page == 1 else MUTED)
    txt(f"{page} / 4", W-70, 13, 7.5, WHITE if page == 1 else MUTED)

def cover_image(path, x, y, w, h):
    im = Image.open(path)
    iw, ih = im.size
    scale = max(w/iw, h/ih)
    nw, nh = iw*scale, ih*scale
    c.drawImage(ImageReader(im), x-(nw-w)/2, y-(nh-h)/2, nw, nh, mask="auto")

def metric(x, y, value, label, color=BLUE):
    txt(value, x, y, 30, color, "InterBold")
    txt(label, x, y-23, 10, MUTED, max_width=150)

# 1 Cover
cover_image(IMG, 0, 0, W, H)
c.setFillColor(Color(0.035,0.08,0.14,0.76))
c.rect(0, 0, W, H, fill=1, stroke=0)
txt("MEDIA KIT", 48, H-58, 10, ORANGE, "InterBold")
txt("Formula 1 Driving School", 48, H-112, 34, WHITE, "InterBold")
txt("Russian-language driving and car content", 48, H-145, 16, SKY)
txt("for an international audience", 48, H-168, 16, SKY)
c.setFillColor(ORANGE)
c.roundRect(48, 126, 220, 94, 10, fill=1, stroke=0)
txt("129,810", 65, 171, 30, NAVY, "InterBold")
txt("Facebook followers", 66, 145, 11, NAVY)
txt("+18,674", 304, 171, 30, WHITE, "InterBold")
txt("net follower growth in 28 days", 305, 145, 11, SKY)
txt("Facebook  facebook.com/avtoshkolatbilisi", 48, 64, 9.5, WHITE)
txt("Website  avtoshkola.ge", 48, 46, 9.5, WHITE)
footer(1)
c.showPage()

# 2 Reach
c.setFillColor(CREAM); c.rect(0,0,W,H,fill=1,stroke=0)
txt("REACH", 44, H-54, 9, ORANGE, "InterBold")
txt("Audience growth and content discovery", 44, H-91, 26, NAVY, "InterBold")
txt("Facebook results for 19 August to 15 September 2026", 44, H-114, 10, MUTED)

metric(54, 358, "8.8M", "content views", BLUE)
metric(268, 358, "5.2M", "viewers reached", BLUE)
metric(482, 358, "96.5%", "views from people who did not follow the page", ORANGE)
metric(696, 358, "+18,674", "net follower growth", ORANGE)

c.setStrokeColor(HexColor("#C8D7E5")); c.setLineWidth(5)
c.line(58, 250, 772, 250)
c.setStrokeColor(BLUE); c.line(58, 250, 620, 250)
c.setFillColor(BLUE); c.circle(620,250,7,fill=1,stroke=0)
txt("Content can travel beyond the existing follower base", 54, 207, 17, NAVY, "InterBold")
txt("The page combines an established audience with strong discovery through Facebook recommendations.", 54, 181, 11, INK, max_width=700)
txt("Figures describe the stated 28-day reporting period. Individual publication results vary.", 54, 72, 8.5, MUTED)
footer(2)
c.showPage()

# 3 Audience
c.setFillColor(WHITE); c.rect(0,0,W,H,fill=1,stroke=0)
txt("AUDIENCE", 44, H-54, 9, ORANGE, "InterBold")
txt("International Russian-speaking community", 44, H-91, 26, NAVY, "InterBold")
txt("Drivers, car owners and people interested in practical driving content", 44, H-116, 11, MUTED)

countries=[("Ukraine",25.5),("Georgia",7.1),("Russia",6.4),("Kyrgyzstan",5.3),("Uzbekistan",5.2)]
base_x=54; base_y=375; bar_w=300
for i,(name,val) in enumerate(countries):
    y=base_y-i*52
    txt(name,base_x,y+8,10,INK)
    c.setFillColor(SKY); c.roundRect(base_x+92,y,bar_w,18,9,fill=1,stroke=0)
    c.setFillColor(BLUE); c.roundRect(base_x+92,y,bar_w*(val/25.5),18,9,fill=1,stroke=0)
    txt(f"{val:.1f}%",base_x+405,y+4,10,NAVY,"InterBold")

c.setFillColor(NAVY); c.roundRect(540,164,250,235,18,fill=1,stroke=0)
txt("59.7%", 568, 333, 34, ORANGE, "InterBold")
txt("aged 35 to 54", 570, 305, 12, WHITE, "InterBold")
txt("29.9%", 568, 251, 28, SKY, "InterBold")
txt("aged 55 and above", 570, 228, 11, WHITE)
txt("49.5% women", 568, 186, 10, SKY)
txt("50.5% men", 680, 186, 10, SKY)
txt("Audience shares are based on lifetime page data.", 54, 72, 8.5, MUTED)
footer(3)
c.showPage()

# 4 Collaboration
c.setFillColor(NAVY); c.rect(0,0,W,H,fill=1,stroke=0)
txt("COLLABORATION", 44, H-54, 9, ORANGE, "InterBold")
txt("Advertising formats", 44, H-91, 26, WHITE, "InterBold")
txt("We can adapt the format to the partner's materials, goals and budget.", 44, H-116, 11, SKY)

items=[
("Sponsored post","A ready-made banner and text, or a post prepared from partner materials."),
("Short video","A supplied video or an original edit based on partner materials."),
("Integrated content","A useful driving or car-related topic featuring the partner's product or service."),
]
for i,(title,desc) in enumerate(items):
    y=370-i*92
    c.setFillColor(WHITE); c.circle(61,y+8,16,fill=1,stroke=0)
    txt(str(i+1),56,y+3,10,NAVY,"InterBold")
    txt(title,91,y+13,14,WHITE,"InterBold")
    txt(desc,91,y-8,9.5,SKY,max_width=590)

txt("After publication, we can provide performance statistics and use a dedicated link or promo code.", 44, 112, 10, WHITE, max_width=700)
txt("Nick  |  autoshkola.ge@gmail.com  |  WhatsApp +995 599 98 77 07", 44, 75, 10, ORANGE, "InterBold")
txt("facebook.com/avtoshkolatbilisi  |  avtoshkola.ge", 44, 53, 9, SKY)
footer(4)
c.save()
print(OUT)
