import DOMPurify from 'dompurify';
import interRegular from '@/assets/fonts/Inter-Regular.woff2?inline';
import interSemibold from '@/assets/fonts/Inter-SemiBold.woff2?inline';
import { CHART } from './chartTheme';
import { CHART_CONTRACT as contract } from './chartCards';

const classes = new Set(contract.classes);
const attributes = new Set(contract.attributes.map(name => name.toLowerCase()));
const htmlTags = new Set(contract.html_tags);
const svgTags = new Set(contract.svg_tags);
const textAttributes = new Set(['class', 'role', 'aria-label']);
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** This module (sanitizer + embedded local fonts) loads only for a chart. */
function safeFragment(html: string): string {
  if (new TextEncoder().encode(html).length > contract.max_html_bytes)
    throw new Error('Le graphique dépasse la limite de taille.');
  const fragment = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['#text', ...contract.html_tags, ...contract.svg_tags],
    ALLOWED_ATTR: contract.attributes,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    SAFE_FOR_XML: true,
    RETURN_DOM_FRAGMENT: true,
    KEEP_CONTENT: false,
  });
  // Sanitized output is the security boundary. Removed content is only a UX
  // signal: do not silently show a chart different from the supplied document.
  if (DOMPurify.removed.some(item => !('element' in item && item.element?.nodeName === 'BODY')))
    throw new Error('Le graphique contient du contenu interdit.');
  const elements = fragment.querySelectorAll('*');
  if (elements.length > contract.max_elements || !fragment.querySelector('svg'))
    throw new Error('Graphique absent ou trop complexe.');
  for (const element of elements) {
    let ancestor: ParentNode | null = element.parentNode;
    for (let depth = 1; ancestor !== fragment; depth++) {
      if (!ancestor || depth >= contract.max_depth) throw new Error('Graphique trop imbriqué.');
      ancestor = ancestor.parentNode;
    }
    const tag = element.localName;
    if (svgTags.has(tag) && element.namespaceURI !== SVG_NAMESPACE)
      throw new Error('Élément SVG hors du graphique.');
    if (htmlTags.has(tag) && element.closest('svg'))
      throw new Error('HTML interdit dans le SVG.');
    if (tag === 'svg' && (!element.hasAttribute('viewBox') || element.parentElement?.closest('svg')))
      throw new Error('SVG imbriqué ou sans viewBox.');
    for (const attribute of element.attributes) {
      const name = attribute.name.toLowerCase();
      if (!attributes.has(name) || (htmlTags.has(tag) && !textAttributes.has(name)))
        throw new Error('Attribut interdit dans le graphique.');
      if (name === 'class' && attribute.value.split(/\s+/).some(value => !classes.has(value)))
        throw new Error('Classe de graphique inconnue.');
      if ((name === 'fill' || name === 'stroke') && !['none', 'currentColor'].includes(attribute.value))
        throw new Error('Les couleurs du graphique doivent suivre le thème.');
    }
  }
  const container = document.createElement('div');
  container.append(fragment);
  return container.innerHTML;
}

function themeStyles(): string {
  const computed = getComputedStyle(document.documentElement);
  return Object.values(CHART).map(value => {
    const variable = value.slice(4, -1);
    return `${variable}:${computed.getPropertyValue(variable)};`;
  }).join('');
}

export function buildChartDocument(html: string): string {
  const fragment = safeFragment(html);
  const series = ['blue', 'green', 'yellow', 'orange', 'red', 'grey', 'cyan', 'gold', 'purple'] as const;
  const seriesStyles = series.map(name => `.series-${name}{color:${CHART[name]};fill:currentColor}`).join('');
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer"><style>
@font-face{font-family:Inter;src:url('${interRegular}') format('woff2');font-weight:400;font-style:normal;font-display:swap}
@font-face{font-family:Inter;src:url('${interSemibold}') format('woff2');font-weight:600;font-style:normal;font-display:swap}
:root{${themeStyles()}}
*{box-sizing:border-box}html,body{margin:0;padding:0;width:100%;font:12px/1.5 Inter,sans-serif;color:${CHART.text};background:transparent;overflow-wrap:anywhere}
body{padding:4px}svg{display:block;width:100%;height:auto;max-width:100%;max-height:calc(100vh - 8px)}svg text{font-family:Inter,sans-serif;fill:${CHART.text};font-size:12px}
p,figure,ul,ol{margin:0 0 8px}table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;table-layout:fixed}th,td{text-align:left;padding:4px;border-bottom:1px solid ${CHART.grid}}
.chart-grid{stroke:${CHART.grid};fill:none;stroke-dasharray:3 3}.chart-axis{stroke:${CHART.axis};fill:none}
.chart-label{fill:${CHART.label};color:${CHART.label}}.chart-title{font-weight:600}.chart-muted{color:${CHART.label};fill:${CHART.label}}
.chart-legend{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}.chart-swatch{display:inline-block;width:9px;height:9px;border-radius:2px;background:currentColor;margin-right:4px}
${seriesStyles}
.chart-line{fill:none;stroke:currentColor;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}.chart-area{opacity:.18;stroke:none}
</style></head><body>${fragment}</body></html>`;
}
