import os
import subprocess
from PIL import Image, ImageDraw, ImageFont

font_bold = "C:/Windows/Fonts/msyhbd.ttc"
font_regular = "C:/Windows/Fonts/msyh.ttc"

books = [
    {
        "file": "serial-suanli-guzhou.jpg",
        "title": "大梁精算师",
        "sub": "我的Token只剩一百亿",
        "tag": "历史脑洞 · 算力求生",
        "author": "作者：老实的理科生",
        "title_color": (248, 250, 255),
        "sub_color": (140, 215, 255),
        "tag_color": (180, 210, 240),
        "author_color": (255, 225, 140),
        "ty": 75, "sy": 175, "ay": 230,
        "title_size": 82, "sub_size": 36, "author_size": 34
    },
    {
        "file": "serial-tianming-fanpai.jpg",
        "title": "天命大反派",
        "sub": "我的后宫全员重生了",
        "tag": "东方玄幻 · 逆天改命 · 后宫修罗场",
        "author": "作者：老实的理科生",
        "title_color": (255, 238, 168),
        "sub_color": (255, 210, 220),
        "tag_color": (255, 225, 170),
        "author_color": (255, 235, 150),
        "ty": 55, "sy": 145, "ay": 195,
        "title_size": 84, "sub_size": 35, "author_size": 32
    },
    {
        "file": "serial-lianai-daka.jpg",
        "title": "刚绑恋爱打卡系统",
        "sub": "高冷学姐怎么全知情？",
        "tag": "都市脑洞 · 校园恋爱 · 反向读心",
        "author": "作者：老实的理科生",
        "title_color": (255, 245, 250),
        "sub_color": (255, 200, 225),
        "tag_color": (255, 225, 235),
        "author_color": (255, 235, 160),
        "ty": 50, "sy": 132, "ay": 182,
        "title_size": 72, "sub_size": 35, "author_size": 32
    },
    {
        "file": "serial-dahuang-wusheng.jpg",
        "title": "大荒武圣",
        "sub": "从矿奴打穿十方天地",
        "tag": "传统玄幻 · 杀伐果断 · 极道肉身",
        "author": "作者：老实的理科生",
        "title_color": (255, 225, 175),
        "sub_color": (255, 160, 130),
        "tag_color": (255, 185, 145),
        "author_color": (255, 230, 160),
        "ty": 45, "sy": 135, "ay": 186,
        "title_size": 86, "sub_size": 35, "author_size": 32
    }
]

for b in books:
    clean_path = "clean_" + b["file"]
    with open(clean_path, "wb") as f:
        subprocess.run(["git", "show", "f0457aa:covers/" + b["file"]], stdout=f, check=True)
    
    base = Image.open(clean_path).convert("RGBA")
    w, h = base.size
    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    
    # Top gradient for typography
    for y in range(int(h * 0.32)):
        alpha = int(170 * (1 - y / (h * 0.32)))
        draw.line([(0, y), (w, y)], fill=(12, 10, 18, alpha))
    
    # Bottom gradient for author pill
    for y in range(int(h * 0.86), h):
        alpha = int(170 * ((y - h * 0.86) / (h * 0.14)))
        draw.line([(0, y), (w, y)], fill=(12, 10, 18, alpha))
    
    t_font = ImageFont.truetype(font_bold, b["title_size"])
    s_font = ImageFont.truetype(font_bold, b["sub_size"])
    tag_font = ImageFont.truetype(font_regular, 22)
    a_font = ImageFont.truetype(font_bold, b["author_size"])
    bottom_a_font = ImageFont.truetype(font_bold, 30)
    
    # Tag
    bbox = draw.textbbox((0, 0), b["tag"], font=tag_font)
    draw.text(((w - (bbox[2] - bbox[0])) // 2, 20), b["tag"], font=tag_font, fill=(*b["tag_color"], 240))
    
    # Title
    bbox = draw.textbbox((0, 0), b["title"], font=t_font)
    tx, ty = (w - (bbox[2] - bbox[0])) // 2, b["ty"]
    for dx, dy in [(-3, -3), (-3, 3), (3, -3), (3, 3), (0, 4), (4, 0), (0, -4), (-4, 0), (0, 5), (-2, 4), (2, 4)]:
        draw.text((tx + dx, ty + dy), b["title"], font=t_font, fill=(15, 5, 10, 250))
    draw.text((tx, ty), b["title"], font=t_font, fill=(*b["title_color"], 255))
    
    # Subtitle
    bbox = draw.textbbox((0, 0), b["sub"], font=s_font)
    sx, sy = (w - (bbox[2] - bbox[0])) // 2, b["sy"]
    for dx, dy in [(-2, -2), (-2, 2), (2, -2), (2, 2), (0, 3), (0, -3), (3, 0), (-3, 0)]:
        draw.text((sx + dx, sy + dy), b["sub"], font=s_font, fill=(15, 5, 10, 240))
    draw.text((sx, sy), b["sub"], font=s_font, fill=(*b["sub_color"], 255))
    
    # Author line under subtitle
    bbox = draw.textbbox((0, 0), b["author"], font=a_font)
    ax, ay = (w - (bbox[2] - bbox[0])) // 2, b["ay"]
    for dx, dy in [(-2, -2), (-2, 2), (2, -2), (2, 2), (0, 3), (3, 0), (0, -3), (-3, 0)]:
        draw.text((ax + dx, ay + dy), b["author"], font=a_font, fill=(15, 5, 10, 245))
    draw.text((ax, ay), b["author"], font=a_font, fill=(*b["author_color"], 255))
    
    # Bottom author badge (rounded rect / pill)
    bottom_text = "老实的理科生 著"
    bbox = draw.textbbox((0, 0), bottom_text, font=bottom_a_font)
    bw = bbox[2] - bbox[0]
    bh = bbox[3] - bbox[1]
    px, py = (w - bw) // 2, h - 70
    draw.rounded_rectangle([px - 22, py - 6, px + bw + 22, py + bh + 10], radius=18, fill=(20, 15, 25, 220), outline=(255, 215, 120, 210), width=2)
    draw.text((px, py), bottom_text, font=bottom_a_font, fill=(255, 235, 160, 255))
    
    final = Image.alpha_composite(base, overlay).convert("RGB")
    final.save("covers/" + b["file"], quality=95)
    if os.path.exists(clean_path):
        os.remove(clean_path)
    print("Generated covers/" + b["file"])

print("All done!")
