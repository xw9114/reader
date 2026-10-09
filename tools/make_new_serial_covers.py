# -*- coding: utf-8 -*-
"""Generate high-end covers for serial-daliang-guoshi and serial-biyi-neishen."""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

FONT_BOLD = "C:/Windows/Fonts/msyhbd.ttc"
FONT_REGULAR = "C:/Windows/Fonts/msyh.ttc"
FONT_SIMSUN = "C:/Windows/Fonts/simsun.ttc"
FONT_KAITI = "C:/Windows/Fonts/simkai.ttf"

def draw_red_seal(draw, x, y, text_lines, font_size=20):
    """Draw a traditional Chinese cinnabar red seal."""
    font = ImageFont.truetype(FONT_KAITI, font_size)
    padding_x = 10
    padding_y = 10
    line_h = font_size + 4
    w = max(draw.textbbox((0, 0), line, font=font)[2] for line in text_lines) + padding_x * 2
    h = len(text_lines) * line_h + padding_y * 2
    
    # Red rounded seal box
    draw.rounded_rectangle([x, y, x + w, y + h], radius=6, fill=(195, 33, 33, 230), outline=(240, 180, 80), width=2)
    # Inner border
    draw.rounded_rectangle([x + 3, y + 3, x + w - 3, y + h - 3], radius=4, outline=(220, 80, 80), width=1)
    
    cur_y = y + padding_y
    for line in text_lines:
        lw = draw.textbbox((0, 0), line, font=font)[2]
        lx = x + (w - lw) // 2
        draw.text((lx, cur_y), line, font=font, fill=(255, 255, 250))
        cur_y += line_h
    return x + w, y + h

def draw_header_badge(draw, cx, cy, tag_text, author_text, font_size=22):
    """Draw a frosted glass modern pill header."""
    font = ImageFont.truetype(FONT_BOLD, font_size)
    full_text = f"{tag_text}   |   {author_text}"
    bbox = draw.textbbox((0, 0), full_text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    
    w = tw + 40
    h = th + 18
    x = cx - w // 2
    y = cy - h // 2
    
    draw.rounded_rectangle([x, y, x + w, y + h], radius=h // 2, fill=(20, 25, 35, 220), outline=(255, 120, 160), width=2)
    draw.text((cx - tw // 2, y + 9), full_text, font=font, fill=(255, 255, 255))

def make_daliang_guoshi_cover():
    src = r"C:\Users\19890\.gemini\antigravity\brain\42be26e8-df5e-4ec7-b044-4d3bdc4877d4\cover_daliang_guoshi_1791534142888.jpg"
    img = Image.open(src).convert("RGBA")
    W, H = img.size
    
    # Overlay dark gradient at top for clear readable typography
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    odraw = ImageDraw.Draw(overlay)
    
    # Top dark vignette
    for y in range(320):
        alpha = int(220 * (1 - y / 320)**1.2)
        odraw.line([(0, y), (W, y)], fill=(10, 15, 25, alpha))
        
    img = Image.alpha_composite(img, overlay)
    draw = ImageDraw.Draw(img)
    
    # Top Tag
    font_tag = ImageFont.truetype(FONT_BOLD, 24)
    tag = "★ 东方历史脑洞 · 降维推演爽文 ★"
    tb = draw.textbbox((0, 0), tag, font=font_tag)
    draw.text(((W - (tb[2] - tb[0])) // 2, 35), tag, font=font_tag, fill=(255, 215, 120))
    
    # Main Title: 大梁第一国师
    font_title = ImageFont.truetype(FONT_BOLD, 74)
    title = "大梁第一国师"
    tb = draw.textbbox((0, 0), title, font=font_title)
    tx = (W - (tb[2] - tb[0])) // 2 - 20
    ty = 85
    
    # Shadow & Glow
    for dx, dy in [(-3, 0), (3, 0), (0, -3), (0, 3), (-2, -2), (2, 2)]:
        draw.text((tx + dx, ty + dy), title, font=font_title, fill=(30, 15, 5, 255))
    draw.text((tx, ty), title, font=font_title, fill=(255, 240, 180))
    
    # Vertical Cinnabar Seal to the right of title
    draw_red_seal(draw, tx + (tb[2] - tb[0]) + 18, ty + 5, ["老实", "理科", "生著"], font_size=18)
    
    # Subtitle: 【开局死牢，我推演算哭满朝文武】
    font_sub = ImageFont.truetype(FONT_BOLD, 30)
    sub = "【开局死牢，我推演算哭满朝文武】"
    sb = draw.textbbox((0, 0), sub, font=font_sub)
    sx = (W - (sb[2] - sb[0])) // 2
    sy = 185
    
    # Subtitle pill
    draw.rounded_rectangle([sx - 15, sy - 6, sx + (sb[2] - sb[0]) + 15, sy + (sb[3] - sb[1]) + 8],
                           radius=8, fill=(15, 25, 35, 220), outline=(220, 180, 80), width=2)
    draw.text((sx, sy), sub, font=font_sub, fill=(255, 235, 140))
    
    out_path = r"E:\codex\reader\covers\serial-daliang-guoshi.jpg"
    img.convert("RGB").save(out_path, quality=95)
    print(f"Saved {out_path}")

def make_biyi_neishen_cover():
    src = r"C:\Users\19890\.gemini\antigravity\brain\42be26e8-df5e-4ec7-b044-4d3bdc4877d4\daily_20261008_3_1791417703657.jpg"
    img = Image.open(src).convert("RGBA")
    W, H = img.size
    
    # Top overlay
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    odraw = ImageDraw.Draw(overlay)
    
    for y in range(350):
        alpha = int(230 * (1 - y / 350)**1.1)
        odraw.line([(0, y), (W, y)], fill=(12, 16, 28, alpha))
        
    img = Image.alpha_composite(img, overlay)
    draw = ImageDraw.Draw(img)
    
    # Header pill badge
    draw_header_badge(draw, W // 2, 45, "都市女频 · 豪门逆袭", "文 · 老实的理科生", font_size=22)
    
    # Main Title 2 lines:
    # 离婚当天
    # 我用百亿内审掀翻前夫全家
    font_t1 = ImageFont.truetype(FONT_BOLD, 70)
    font_t2 = ImageFont.truetype(FONT_BOLD, 46)
    
    t1 = "离婚当天"
    t2 = "我用百亿内审掀翻前夫全家"
    
    b1 = draw.textbbox((0, 0), t1, font=font_t1)
    b2 = draw.textbbox((0, 0), t2, font=font_t2)
    
    x1 = (W - (b1[2] - b1[0])) // 2
    y1 = 90
    
    for dx, dy in [(-3, 0), (3, 0), (0, -3), (0, 3)]:
        draw.text((x1 + dx, y1 + dy), t1, font=font_t1, fill=(20, 10, 30))
    draw.text((x1, y1), t1, font=font_t1, fill=(255, 255, 255))
    
    x2 = (W - (b2[2] - b2[0])) // 2
    y2 = 180
    
    for dx, dy in [(-2, 0), (2, 0), (0, -2), (0, 2)]:
        draw.text((x2 + dx, y2 + dy), t2, font=font_t2, fill=(20, 10, 30))
    draw.text((x2, y2), t2, font=font_t2, fill=(255, 215, 120))
    
    # Subtitle badge: ✦ 手撕渣男 · 资产冻结 · 绝不原谅 ✦
    font_sub = ImageFont.truetype(FONT_BOLD, 24)
    sub = "✦ 手撕渣男 · 资产冻结 · 绝不原谅 ✦"
    sb = draw.textbbox((0, 0), sub, font=font_sub)
    sx = (W - (sb[2] - sb[0])) // 2
    sy = 250
    
    draw.rounded_rectangle([sx - 16, sy - 5, sx + (sb[2] - sb[0]) + 16, sy + (sb[3] - sb[1]) + 7],
                           radius=14, fill=(245, 60, 110, 230), outline=(255, 255, 255), width=2)
    draw.text((sx, sy), sub, font=font_sub, fill=(255, 255, 255))
    
    out_path = r"E:\codex\reader\covers\serial-biyi-neishen.jpg"
    img.convert("RGB").save(out_path, quality=95)
    print(f"Saved {out_path}")

if __name__ == "__main__":
    make_daliang_guoshi_cover()
    make_biyi_neishen_cover()
