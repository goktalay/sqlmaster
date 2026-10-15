// Sürüklenebilir bölücü: önceki kardeş öğenin boyutunu oranla ayarlar.
export function splitter(handle: HTMLElement, first: HTMLElement, axis: 'x' | 'y', initial: number, onDone?: (px: number) => void) {
  const parent = handle.parentElement!;
  const apply = (ratio: number) => {
    const r = Math.min(0.88, Math.max(0.08, ratio));
    first.style.flex = `0 0 ${r * 100}%`;
  };
  apply(initial);
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const rect = parent.getBoundingClientRect();
    handle.classList.add('active');
    document.body.classList.add(axis === 'x' ? 'resizing-col' : 'resizing-row');
    const move = (ev: MouseEvent) => apply(axis === 'x' ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height);
    const up = () => {
      handle.classList.remove('active');
      document.body.classList.remove('resizing-col', 'resizing-row');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      onDone?.(axis === 'x' ? first.getBoundingClientRect().width : first.getBoundingClientRect().height);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}
