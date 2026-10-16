"""Gera os icones PNG do app (192 e 512) a partir do mesmo desenho da logo.

Desenha direto com PIL em vez de converter SVG — menos dependencia e
o resultado e identico ao logo do LEVERAGE ARB.
"""
import os
from PIL import Image, ImageDraw

AQUI = os.path.dirname(os.path.abspath(__file__))
SAIDA = os.path.join(AQUI, "public", "icons")
os.makedirs(SAIDA, exist_ok=True)

# escala: o viewBox do SVG e 96x96
def gerar(tamanho: int, arquivo: str, margem: float = 0.0):
    S = tamanho
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    def u(v):  # converte viewBox -> pixels
        return (v / 96.0) * S

    # fundo preto arredondado com borda laranja
    r = u(22)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=r, fill=(10, 10, 10, 255))
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=r, outline=(255, 107, 0, 110), width=max(1, int(u(2))))

    # gradiente vertical simples por faixa (branco -> cinza, laranja -> laranja escuro)
    def grad(x, y, w, h, topo, base, raio):
        passos = max(1, int(h))
        for i in range(passos):
            t = i / passos
            cor = tuple(int(topo[k] + (base[k] - topo[k]) * t) for k in range(3)) + (255,)
            yy0 = y + i
            d.rectangle([x, yy0, x + w, yy0 + 1], fill=cor)

    # vela branca
    grad(u(22), u(16), u(6), u(48), (255, 255, 255), (224, 224, 224), 0)
    grad(u(18), u(32), u(14), u(26), (255, 255, 255), (224, 224, 224), 0)

    # vela laranja
    grad(u(45), u(12), u(6), u(54), (255, 179, 71), (255, 107, 0), 0)
    grad(u(41), u(24), u(14), u(32), (255, 179, 71), (255, 107, 0), 0)

    # vela laranja 2
    grad(u(68), u(28), u(6), u(48), (255, 179, 71), (255, 107, 0), 0)
    grad(u(64), u(42), u(14), u(30), (255, 179, 71), (255, 107, 0), 0)

    caminho = os.path.join(SAIDA, arquivo)
    img.save(caminho, "PNG")
    print(f"  {arquivo}  {S}x{S}")
    return caminho


print("Gerando icones do app:")
gerar(192, "icon-192.png")
gerar(512, "icon-512.png")

# atalho do Windows / PWA tab
gerar(32, "favicon-32.png")
print("Pronto ->", SAIDA)