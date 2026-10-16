/**
 * Logo — mesmo desenho do LEVERAGE ARB (candles laranja sobre fundo preto).
 * Mantido identico para o painel ter a mesma identidade visual.
 */
export function Logo({ tamanho = 38 }: { tamanho?: number }) {
  return (
    <svg viewBox="0 0 96 96" width={tamanho} height={tamanho} fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="lg-fundo" x1="0" y1="0" x2="96" y2="96" gradientUnits="userSpaceOnUse">
          <stop stopColor="#1A1A1A" />
          <stop offset="1" stopColor="#000000" />
        </linearGradient>
        <linearGradient id="lg-laranja" x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="#FFB347" />
          <stop offset="1" stopColor="#FF6B00" />
        </linearGradient>
        <linearGradient id="lg-branco" x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="#FFFFFF" />
          <stop offset="1" stopColor="#E0E0E0" />
        </linearGradient>
      </defs>
      <rect width="96" height="96" rx="22" fill="url(#lg-fundo)" stroke="#FF6B00" strokeOpacity="0.35" />
      <rect x="22" y="16" width="6" height="48" rx="3" fill="url(#lg-branco)" />
      <rect x="18" y="32" width="14" height="26" rx="3" fill="url(#lg-branco)" />
      <rect x="45" y="12" width="6" height="54" rx="3" fill="url(#lg-laranja)" />
      <rect x="41" y="24" width="14" height="32" rx="3" fill="url(#lg-laranja)" />
      <rect x="68" y="28" width="6" height="48" rx="3" fill="url(#lg-laranja)" />
      <rect x="64" y="42" width="14" height="30" rx="3" fill="url(#lg-laranja)" />
    </svg>
  );
}