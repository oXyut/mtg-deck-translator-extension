/**
 * カード画像にマウスを乗せたときに拡大画像をオーバーレイ表示する。
 * Archidekt の Playtest には Moxfield のようなホバー拡大が無いため補完する。
 */
export function startHoverZoom(
  getZoomSrc: (img: HTMLImageElement) => string | null,
  isEnabled: () => boolean,
): void {
  let overlay: HTMLDivElement | null = null;
  let overlayImg: HTMLImageElement | null = null;
  let current: HTMLImageElement | null = null;

  function ensureOverlay(): HTMLImageElement {
    if (overlay && overlayImg) return overlayImg;
    overlay = document.createElement('div');
    overlay.style.cssText = [
      'position: fixed',
      'z-index: 2147483647',
      'pointer-events: none',
      'display: none',
      'filter: drop-shadow(0 4px 16px rgba(0,0,0,0.5))',
    ].join(';');
    overlayImg = document.createElement('img');
    overlayImg.style.cssText = [
      'display: block',
      'width: clamp(280px, 26vw, 420px)',
      'max-height: 88vh',
      'height: auto',
      'border-radius: 4.75% / 3.5%', // MTGカードの角丸に合わせる
    ].join(';');
    overlay.appendChild(overlayImg);
    document.documentElement.appendChild(overlay);
    return overlayImg;
  }

  function hide(): void {
    current = null;
    if (overlay) overlay.style.display = 'none';
  }

  function position(e: MouseEvent): void {
    if (!overlay || overlay.style.display === 'none') return;
    const w = overlay.offsetWidth;
    const h = overlay.offsetHeight;
    const margin = 16;
    let x = e.clientX + margin;
    if (x + w > window.innerWidth - margin) x = e.clientX - margin - w;
    const y = Math.min(
      Math.max(e.clientY - h / 2, margin),
      window.innerHeight - h - margin,
    );
    overlay.style.left = `${Math.max(x, margin)}px`;
    overlay.style.top = `${y}px`;
  }

  document.addEventListener('mouseover', (e) => {
    if (!isEnabled()) return hide();
    const target = e.target;
    if (!(target instanceof HTMLImageElement)) return hide();
    const src = getZoomSrc(target);
    if (!src) return hide();

    current = target;
    const img = ensureOverlay();
    if (img.src !== src) {
      // 拡大版が無い場合は元画像にフォールバック
      img.onerror = () => {
        if (current === target) img.src = target.currentSrc || target.src;
      };
      img.src = src;
    }
    overlay!.style.display = 'block';
    position(e);
  });

  document.addEventListener('mousemove', (e) => {
    if (current) position(e);
  });

  document.addEventListener(
    'scroll',
    () => {
      if (current) hide();
    },
    { capture: true, passive: true },
  );
}
