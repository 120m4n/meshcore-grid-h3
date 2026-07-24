const ICONS: Record<string, string> = {
  ruler: '📏',
  arc: '🧭',
};

const LABELS: Record<string, string> = {
  ruler: 'Regla — medir distancia',
  arc: 'Rumbo — medir ángulo desde el norte',
};

export class McToolButton extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['tool', 'active'];
  }

  private button: HTMLButtonElement;

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        button {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 30px;
          height: 30px;
          padding: 0;
          background: var(--surface-raised, #16283d);
          color: var(--text, #e7edf2);
          border: none;
          border-bottom: 1px solid var(--border, #24384f);
          font-size: 1rem;
          line-height: 1;
          cursor: pointer;
        }
        button:last-of-type { border-bottom: none; }
        button:hover { background: rgba(52, 215, 192, 0.12); }
        button.active {
          background: var(--accent, #34d7c0);
          color: var(--accent-text, #06211d);
        }
      </style>
      <button type="button"></button>
    `;
    this.button = shadow.querySelector('button')!;
    this.button.addEventListener('click', () => {
      this.dispatchEvent(
        new CustomEvent('mc-tool-toggle', {
          detail: { tool: this.tool },
          bubbles: true,
          composed: true,
        })
      );
    });
  }

  connectedCallback(): void {
    this.render();
  }

  attributeChangedCallback(): void {
    this.render();
  }

  get tool(): 'ruler' | 'arc' {
    return this.getAttribute('tool') === 'arc' ? 'arc' : 'ruler';
  }

  get active(): boolean {
    return this.hasAttribute('active');
  }

  set active(value: boolean) {
    if (value) this.setAttribute('active', '');
    else this.removeAttribute('active');
  }

  private render(): void {
    const tool = this.tool;
    this.button.textContent = ICONS[tool];
    this.button.title = LABELS[tool];
    this.button.setAttribute('aria-label', LABELS[tool]);
    this.button.setAttribute('aria-pressed', String(this.active));
    this.button.classList.toggle('active', this.active);
  }
}

customElements.define('mc-tool-button', McToolButton);

declare global {
  interface HTMLElementTagNameMap {
    'mc-tool-button': McToolButton;
  }
}
