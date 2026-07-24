import './mc-tool-button.ts';

export class McMapToolbar extends HTMLElement {
  constructor() {
    super();
    const shadow = this.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host {
          display: block;
          border-radius: 4px;
          overflow: hidden;
          border: 1px solid var(--border-bright, #345070);
          box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
        }
      </style>
      <mc-tool-button tool="ruler"></mc-tool-button>
      <mc-tool-button tool="arc"></mc-tool-button>
      <mc-tool-button tool="eraser"></mc-tool-button>
    `;
  }
}

customElements.define('mc-map-toolbar', McMapToolbar);

declare global {
  interface HTMLElementTagNameMap {
    'mc-map-toolbar': McMapToolbar;
  }
}
