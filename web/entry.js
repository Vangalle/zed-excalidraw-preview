window.EXCALIDRAW_ASSET_PATH = new URL('./assets/', location.href).href;
const { restore, exportToCanvas, exportToSvg, exportToBlob } = await import('@excalidraw/excalidraw');
const viewport = document.querySelector('#viewport');
const drawing = document.querySelector('#drawing');
const status = document.querySelector('#status');
const reload = document.querySelector('#reload');
let scene;
let width = 640;
let height = 360;
let scale = 1;
let x = 0;
let y = 0;
let drag;

function updateView() {
  drawing.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  document.querySelector('#zoom').textContent = `${Math.round(scale * 100)}%`;
}
function fit() {
  scale = Math.min((viewport.clientWidth - 64) / width, (viewport.clientHeight - 64) / height, 1);
  scale = Math.max(0.001, scale);
  x = (viewport.clientWidth - width * scale) / 2;
  y = (viewport.clientHeight - height * scale) / 2;
  updateView();
}
function zoom(factor, cx = viewport.clientWidth / 2, cy = viewport.clientHeight / 2) {
  const next = Math.min(16, Math.max(0.001, scale * factor));
  x = cx - (cx - x) * next / scale;
  y = cy - (cy - y) * next / scale;
  scale = next;
  updateView();
}
function emptySvg() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '640'); svg.setAttribute('height', '360');
  svg.setAttribute('viewBox', '0 0 640 360');
  return svg;
}
async function load() {
  reload.disabled = true;
  delete document.body.dataset.ready;
  delete document.body.dataset.error;
  status.textContent = 'Rendering…';
  try {
    const response = await fetch('./scene', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to read the drawing file.');
    scene = restore(data, null, null, { repairBindings: true });
    scene.elements = scene.elements.filter(element => !element.isDeleted);
    scene.appState = {
      ...scene.appState,
      exportBackground: data.appState?.exportBackground !== false,
      exportEmbedScene: false,
      exportWithDarkMode: data.appState?.exportWithDarkMode === true,
    };
    const textElements = scene.elements.filter(element => element.type === 'text');
    if (textElements.length) {
      // SVG export without inlining does not register/load fonts. The official
      // canvas exporter does; a 1px text-only export prepares local FontFaces
      // without rasterizing a large drawing or depending on private font APIs.
      await exportToCanvas({ ...scene, elements: textElements, files: {}, maxWidthOrHeight: 1 });
    }
    const svg = scene.elements.length
      ? await exportToSvg({ ...scene, exportPadding: 20, skipInliningFonts: true })
      : emptySvg();
    // Even saved element links are inert in this strictly read-only viewer.
    for (const link of svg.querySelectorAll('a')) {
      link.removeAttribute('href'); link.removeAttribute('xlink:href');
    }
    width = parseFloat(svg.getAttribute('width')) || 640;
    height = parseFloat(svg.getAttribute('height')) || 360;
    drawing.replaceChildren(svg);
    // This SVG is displayed inline, so it can use the document's local FontFaces;
    // standalone font subsetting workers/eval and embedded fonts are unnecessary.
    await document.fonts.ready;
    fit();
    status.textContent = scene.elements.length ? `${scene.elements.length} elements · Rendered locally` : 'Empty canvas';
    document.body.dataset.ready = 'true';
  } catch (error) {
    status.textContent = `Preview failed: ${error.message} If the server has expired, run the preview action again in Zed.`;
    document.body.dataset.error = 'true';
    throw error;
  } finally {
    reload.disabled = false;
  }
}

window.exportPng = async () => {
  if (!scene || document.body.dataset.error) throw new Error('Scene is not ready.');
  let blob;
  if (scene.elements.length) {
    blob = await exportToBlob({ ...scene, mimeType: 'image/png', exportPadding: 20, maxWidthOrHeight: 8192 });
  } else {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = scene.appState.viewBackgroundColor || '#ffffff'; ctx.fillRect(0, 0, 640, 360);
    blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  }
  if (!blob) throw new Error('PNG export failed.');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(new Error('Unable to encode PNG.'));
    reader.readAsDataURL(blob);
  });
};

document.querySelector('#zoom-in').onclick = () => zoom(1.25);
document.querySelector('#zoom-out').onclick = () => zoom(0.8);
document.querySelector('#fit').onclick = fit;
reload.onclick = () => load().catch(() => {});
viewport.ondblclick = fit;
viewport.addEventListener('wheel', event => {
  event.preventDefault();
  const rect = viewport.getBoundingClientRect();
  zoom(Math.exp(-event.deltaY * 0.002), event.clientX - rect.left, event.clientY - rect.top);
}, { passive: false });
viewport.onpointerdown = event => {
  if (event.button !== 0) return;
  viewport.setPointerCapture(event.pointerId);
  drag = { px: event.clientX, py: event.clientY, x, y };
  viewport.classList.add('dragging');
};
viewport.onpointermove = event => {
  if (!drag) return;
  x = drag.x + event.clientX - drag.px;
  y = drag.y + event.clientY - drag.py;
  updateView();
};
viewport.onpointerup = viewport.onpointercancel = () => { drag = null; viewport.classList.remove('dragging'); };
new ResizeObserver(() => { if (scene) fit(); }).observe(viewport);
await load().catch(() => {});
