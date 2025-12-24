// SVG icon generation for UI components

const NS = 'http://www.w3.org/2000/svg';

interface IconNode {
  tag: string;
  attrs: Record<string, string>;
}

const ICONS: Record<string, IconNode[]> = {
  queue: [
    { tag: 'path', attrs: { d: 'M4 6h12', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' } },
    { tag: 'path', attrs: { d: 'M4 10h12', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' } },
    { tag: 'path', attrs: { d: 'M4 14h8', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' } },
    { tag: 'path', attrs: { d: 'M18 8v6', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' } },
    { tag: 'path', attrs: { d: 'M15 11h6', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' } },
  ],
  plus: [
    { tag: 'path', attrs: { d: 'M12 5v14M5 12h14', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' } },
  ],
  x: [
    { tag: 'path', attrs: { d: 'M6 6l12 12', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' } },
    { tag: 'path', attrs: { d: 'M18 6L6 18', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' } },
  ],
  trash: [
    { tag: 'rect', attrs: { x: '5', y: '8', width: '14', height: '12', rx: '2', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' } },
    { tag: 'path', attrs: { d: 'M9 3h6v3H9z', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' } },
    { tag: 'path', attrs: { d: 'M4 6h16', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' } },
  ],
  chevronDown: [
    { tag: 'path', attrs: { d: 'M6 9l6 6 6-6', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } },
  ],
  pause: [
    { tag: 'rect', attrs: { x: '6', y: '4', width: '4', height: '16', rx: '1', fill: 'currentColor' } },
    { tag: 'rect', attrs: { x: '14', y: '4', width: '4', height: '16', rx: '1', fill: 'currentColor' } },
  ],
  play: [
    { tag: 'polygon', attrs: { points: '8,5 19,12 8,19', fill: 'currentColor' } },
  ],
};

export function createIcon(name: string, options: { size?: number } = {}): SVGSVGElement {
  const { size = 16 } = options;
  const def = ICONS[name];
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');

  if (!def) return svg;

  for (const node of def) {
    const el = document.createElementNS(NS, node.tag);
    for (const [k, v] of Object.entries(node.attrs)) {
      el.setAttribute(k, v);
    }
    svg.appendChild(el);
  }

  return svg;
}
