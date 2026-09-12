import { FileView, Notice, setIcon, TFile, WorkspaceLeaf } from 'obsidian';
import type PdfDuhPlugin from './main';
import {
	getMupdfEngine,
	MupdfDocument,
	MupdfEngine,
	PdfPasswordError,
} from './libmupdf';
import type { OutlineItem } from './libmupdf';
import type { RenderedPage } from './libmupdf';

export const VIEW_TYPE_PDF_VIEWER = 'mupdf-viewer';

export type PageLayoutMode =
	| 'single'
	| 'single-fit-height'
	| 'two-odd-left'
	| 'two-even-left';

/**
 * The active PDF viewer, or the first open viewer with a document when no
 * viewer tab is active.
 */
export function findPdfViewer(app: import('obsidian').App): PdfViewerView | null {
	const activeView =
		app.workspace.getActiveViewOfType<PdfViewerView>(PdfViewerView);
	if (activeView?.doc) {
		return activeView;
	}
	for (const leaf of app.workspace.getLeavesOfType(VIEW_TYPE_PDF_VIEWER)) {
		const view = leaf.view;
		if (view instanceof PdfViewerView && view.doc) {
			return view;
		}
	}
	return null;
}

export class PdfViewerView extends FileView {
	private engine: MupdfEngine | null = null;
	doc: MupdfDocument | null = null;
	private pageCount = 0;
	private pageIndex = 0;
	private layoutMode: PageLayoutMode = 'single';
	private rendering = false;
	private renderQueued = false;
	private pendingFitRender = false;
	private resizeRenderHandle: number | null = null;

	private canvasEl!: HTMLCanvasElement;
	private scrollEl!: HTMLElement;
	private pageInputEl!: HTMLInputElement;
	private pageCountLabelEl!: HTMLElement;
	private prevButtonEl!: HTMLButtonElement;
	private nextButtonEl!: HTMLButtonElement;
	private layoutButtons!: Record<PageLayoutMode, HTMLButtonElement>;

	private static readonly LAYOUT_BUTTON_ICONS: Record<
		PageLayoutMode,
		string
	> = {
		single: 'rectangle-vertical',
		'single-fit-height': 'stretch-vertical',
		'two-odd-left': 'mupdf-two-pages-odd-left',
		'two-even-left': 'mupdf-two-pages-even-left',
	};

	constructor(leaf: WorkspaceLeaf, private plugin: PdfDuhPlugin) {
		super(leaf);
		this.navigation = true;
	}

	getViewType(): string {
		return VIEW_TYPE_PDF_VIEWER;
	}

	getDisplayText(): string {
		return this.file ? this.file.name : 'PDF';
	}

	getIcon(): string {
		return 'file-text';
	}

	get currentPage(): number {
		return this.pageIndex;
	}

	/** Whether the current layout shows a two-page spread. */
	private get isTwoUp(): boolean {
		return (
			this.layoutMode === 'two-odd-left' ||
			this.layoutMode === 'two-even-left'
		);
	}

	/** Pages to advance per navigation step (2 in spread modes). */
	private get pageStep(): number {
		return this.isTwoUp ? 2 : 1;
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('mupdf-viewer');

		const toolbarEl = contentEl.createDiv('mupdf-viewer-toolbar');

		this.prevButtonEl = toolbarEl.createEl('button', { cls: 'clickable-icon' });
		setIcon(this.prevButtonEl, 'chevron-left');
		this.prevButtonEl.addEventListener('click', () => {
			void this.goToPage(this.pageIndex - this.pageStep);
		});

		this.pageInputEl = toolbarEl.createEl('input', {
			cls: 'mupdf-viewer-page-input',
			type: 'text',
		});
		this.pageInputEl.inputMode = 'numeric';
		this.pageInputEl.disabled = true;
		this.pageInputEl.addEventListener('keydown', (event: KeyboardEvent) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				const value = Number.parseInt(this.pageInputEl.value, 10);
				if (
					Number.isInteger(value) &&
					value >= 1 &&
					value <= this.pageCount &&
					value !== this.pageIndex + 1
				) {
					void this.goToPage(value - 1);
					this.pageInputEl.blur();
				} else {
					this.pageInputEl.value = String(this.pageIndex + 1);
				}
			}
		});
		this.pageInputEl.addEventListener('blur', () => {
			this.pageInputEl.value = String(this.pageIndex + 1);
		});

		this.pageCountLabelEl = toolbarEl.createSpan('mupdf-viewer-page-label');
		this.pageCountLabelEl.setText('of -');

		this.nextButtonEl = toolbarEl.createEl('button', { cls: 'clickable-icon' });
		setIcon(this.nextButtonEl, 'chevron-right');
		this.nextButtonEl.addEventListener('click', () => {
			void this.goToPage(this.pageIndex + this.pageStep);
		});

		this.layoutButtons = {
			single: toolbarEl.createEl('button', {
				cls: 'clickable-icon mupdf-viewer-layout-button',
				attr: { 'aria-label': 'Single page, fit width', title: 'Single page, fit width' },
			}),
			'single-fit-height': toolbarEl.createEl('button', {
				cls: 'clickable-icon mupdf-viewer-layout-button',
				attr: { 'aria-label': 'Single page, fit height', title: 'Single page, fit height' },
			}),
			'two-odd-left': toolbarEl.createEl('button', {
				cls: 'clickable-icon mupdf-viewer-layout-button',
				attr: { 'aria-label': 'Two pages, odd on the left', title: 'Two pages, odd on the left' },
			}),
			'two-even-left': toolbarEl.createEl('button', {
				cls: 'clickable-icon mupdf-viewer-layout-button',
				attr: { 'aria-label': 'Two pages, even on the left', title: 'Two pages, even on the left' },
			}),
		};
		for (const mode of Object.keys(this.layoutButtons) as PageLayoutMode[]) {
			const button = this.layoutButtons[mode];
			setIcon(button, PdfViewerView.LAYOUT_BUTTON_ICONS[mode]);
			button.addEventListener('click', () => {
				if (this.layoutMode === mode) {
					return;
				}
				this.layoutMode = mode;
				this.updateLayoutButtonStates();
				void this.renderCurrent();
			});
		}
		this.updateLayoutButtonStates();

		toolbarEl.createDiv('mupdf-viewer-toolbar-spacer');

		this.scrollEl = contentEl.createDiv('mupdf-viewer-scroll');
		this.canvasEl = this.scrollEl.createEl('canvas');
		this.canvasEl.addClass('mupdf-viewer-canvas');

		const observer = new ResizeObserver(() => {
			this.requestResizeRender();
		});
		observer.observe(this.scrollEl);
		this.register(() => observer.disconnect());
		this.register(() => {
			if (this.resizeRenderHandle !== null) {
				cancelAnimationFrame(this.resizeRenderHandle);
				this.resizeRenderHandle = null;
			}
		});

		this.registerDomEvent(document, 'keydown', (event: KeyboardEvent) => {
			if (event.ctrlKey || event.metaKey || event.altKey) {
				return;
			}
			const target = event.target;
			if (
				target instanceof HTMLElement &&
				(target.isContentEditable ||
					target.tagName === 'INPUT' ||
					target.tagName === 'TEXTAREA' ||
					target.tagName === 'SELECT')
			) {
				return;
			}
			if (this.app.workspace.getActiveViewOfType(PdfViewerView) !== this) {
				return;
			}
			const key = event.key.toLowerCase();
			if (key !== 'n' && key !== 'p') {
				return;
			}
			if (event.shiftKey) {
				this.goToBookmark(key === 'n' ? 1 : -1);
			} else {
				void this.goToPage(
					key === 'n'
						? this.pageIndex + this.pageStep
						: this.pageIndex - this.pageStep
				);
			}
		});
	}

	private requestResizeRender(): void {
		if (this.resizeRenderHandle !== null) {
			return;
		}
		this.resizeRenderHandle = requestAnimationFrame(() => {
			this.resizeRenderHandle = null;
			this.requestRender();
		});
	}

	async onLoadFile(file: TFile): Promise<void> {
		this.doc?.destroy();
		this.doc = null;
		this.pageCount = 0;
		this.pageIndex = 0;
		this.pageInputEl.disabled = true;
		this.pageInputEl.value = '-';
		this.pageCountLabelEl.setText('/ -');
		try {
			const [engine, data] = await Promise.all([
				getMupdfEngine(
					(path) => this.app.vault.adapter.readBinary(path),
					this.plugin.mupdfWasmPath()
				),
				this.app.vault.readBinary(file),
			]);
			this.engine = engine;
			this.doc = engine.openDocument(new Uint8Array(data));
			this.pageCount = this.doc.countPages();
			await this.renderCurrent();
			this.plugin.refreshPdfStructureViews();
		} catch (error) {
			console.error('PDF Duh: failed to open PDF', error);
			const message =
				error instanceof PdfPasswordError
					? 'This PDF is password protected'
					: 'Failed to render this PDF';
			new Notice(`PDF Duh: ${message}`);
		}
	}

	async onUnloadFile(_file: TFile): Promise<void> {
		this.doc?.destroy();
		this.doc = null;
		this.pageCount = 0;
		this.plugin.refreshPdfStructureViews();
	}

	async onClose(): Promise<void> {
		this.doc?.destroy();
		this.doc = null;
		this.plugin.refreshPdfStructureViews();
	}

	async goToPage(index: number): Promise<void> {
		if (!this.doc || index < 0 || index >= this.pageCount) {
			return;
		}
		this.pageIndex = index;
		await this.renderCurrent();
		this.plugin.updatePdfPageHighlight(this.pageIndex);
	}

	/** Sorted, de-duplicated page indexes of every bookmark in the outline. */
	private bookmarkPages(): number[] {
		if (!this.doc) {
			return [];
		}
		const pages = new Set<number>();
		const walk = (items: OutlineItem[]): void => {
			for (const item of items) {
				if (item.page !== null) {
					pages.add(item.page);
				}
				walk(item.children);
			}
		};
		walk(this.doc.loadOutline() ?? []);
		return [...pages].sort((a, b) => a - b);
	}

	/**
	 * Jump to the nearest bookmark. direction 1 = next bookmark after the
	 * current page, -1 = previous bookmark before it. No-ops when there is
	 * none in that direction.
	 */
	private goToBookmark(direction: 1 | -1): void {
		const pages = this.bookmarkPages();
		if (pages.length === 0) {
			return;
		}
		const target =
			direction === 1
				? pages.find((page) => page > this.pageIndex)
				: pages
						.slice()
						.reverse()
						.find((page) => page < this.pageIndex);
		if (target === undefined) {
			return;
		}
		void this.goToPage(target);
	}

	/** The first page index visible in the current layout at this.pageIndex. */
	private firstVisiblePageIndex(): number {
		if (!this.isTwoUp) {
			return this.pageIndex;
		}
		if (this.layoutMode === 'two-even-left') {
			// Even page number on the left: pageIndex 0 (page 1) sits alone
			// on the right; the spread containing it starts at index -1.
			if (this.pageIndex === 0) {
				return -1;
			}
			return this.pageIndex % 2 === 1 ? this.pageIndex : this.pageIndex - 1;
		}
		// Odd page number on the left: spreads start at even indexes.
		return this.pageIndex % 2 === 0 ? this.pageIndex : this.pageIndex - 1;
	}

	private updateLayoutButtonStates(): void {
		for (const mode of Object.keys(this.layoutButtons) as PageLayoutMode[]) {
			const button = this.layoutButtons[mode];
			button.toggleClass('is-active', this.layoutMode === mode);
			button.setAttribute('aria-pressed', this.layoutMode === mode ? 'true' : 'false');
		}
	}

	private async renderCurrent(): Promise<void> {
		if (!this.doc) {
			return;
		}
		if (this.rendering) {
			this.renderQueued = true;
			return;
		}
		const displayWidth = this.getAvailableWidth();
		if (displayWidth <= 0) {
			this.pendingFitRender = true;
			return;
		}
		this.rendering = true;
		this.pageInputEl.disabled = true;
		this.pendingFitRender = false;
		try {
			const bitmapWidth = Math.max(
				1,
				Math.round(displayWidth * this.plugin.settings.renderScale)
			);
			const leftIndex = this.firstVisiblePageIndex();
			const rightIndex = leftIndex + 1;
			const twoUp = this.isTwoUp;
			const fitHeight = this.layoutMode === 'single-fit-height';
			let pageBitmapWidth: number;
			if (twoUp) {
				// In two-page mode each page gets half the panel width.
				pageBitmapWidth = Math.max(1, Math.round(bitmapWidth / 2));
			} else if (fitHeight) {
				// Scale by the pane height, so the bitmap width follows the
				// page's aspect ratio.
				const displayHeight = this.getAvailableHeight();
				const bounds = this.doc.pageBounds(leftIndex);
				const pageAspect =
					Math.max(1, bounds[2] - bounds[0]) /
					Math.max(1, bounds[3] - bounds[1]);
				pageBitmapWidth = Math.max(
					1,
					Math.round(
						displayHeight *
							pageAspect *
							this.plugin.settings.renderScale
					)
				);
			} else {
				pageBitmapWidth = bitmapWidth;
			}
			const left =
				leftIndex >= 0 && leftIndex < this.pageCount
					? this.doc.renderPage(leftIndex, pageBitmapWidth)
					: null;
			// renderPage reuses a shared pixel buffer, so copy the left
			// page out before rendering the right one over it.
			if (left && twoUp) {
				left.pixels = new Uint8ClampedArray(left.pixels);
			}
			const right =
				twoUp && rightIndex >= 0 && rightIndex < this.pageCount
					? this.doc.renderPage(rightIndex, pageBitmapWidth)
					: null;
			if (!left && !right) {
				throw new Error('PDF Duh: nothing to render');
			}
			const composed = twoUp
				? this.composeTwoPages(left, right)
				: left!;
			this.canvasEl.width = composed.width;
			this.canvasEl.height = composed.height;
			if (fitHeight && !twoUp) {
				const displayHeight = this.getAvailableHeight();
				this.canvasEl.style.height = `${displayHeight}px`;
				this.canvasEl.style.width = `${Math.round(
					(displayHeight * composed.width) / composed.height
				)}px`;
			} else {
				this.canvasEl.style.width = `${displayWidth}px`;
				this.canvasEl.style.height = `${Math.round(
					(displayWidth * composed.height) / composed.width
				)}px`;
			}
			const ctx = this.canvasEl.getContext('2d');
			if (!ctx) {
				throw new Error('Canvas 2D context unavailable');
			}
			ctx.putImageData(
				new ImageData(composed.pixels, composed.width, composed.height),
				0,
				0
			);
			this.pageInputEl.value = String(this.pageIndex + 1);
			this.pageInputEl.disabled = false;
			this.pageCountLabelEl.setText(`of ${this.pageCount}`);
			this.prevButtonEl.disabled = this.pageIndex <= 0;
			this.nextButtonEl.disabled =
				this.pageIndex + 1 >= this.pageCount;
		} finally {
			this.rendering = false;
			if (this.renderQueued) {
				this.renderQueued = false;
				void this.renderCurrent();
			}
		}
	}

	private getAvailableWidth(): number {
		if (!this.scrollEl) {
			return 0;
		}
		const cs = getComputedStyle(this.scrollEl);
		const available =
			this.scrollEl.clientWidth -
			parseFloat(cs.paddingLeft) -
			parseFloat(cs.paddingRight);
		return Math.round(available);
	}

	private getAvailableHeight(): number {
		if (!this.scrollEl) {
			return 0;
		}
		const cs = getComputedStyle(this.scrollEl);
		const available =
			this.scrollEl.clientHeight -
			parseFloat(cs.paddingTop) -
			parseFloat(cs.paddingBottom);
		return Math.round(available);
	}

	/**
	 * Compose two pages side by side into one bitmap. A null side is
	 * filled with white. Both pages were rendered at the same width, so
	 * they share the same height unless the document has mixed page sizes;
	 * the canvas uses the taller height and pages are top-aligned.
	 */
	private composeTwoPages(
		left: RenderedPage | null,
		right: RenderedPage | null
	): RenderedPage {
		const height = Math.max(
			1,
			Math.max(left ? left.height : 0, right ? right.height : 0)
		);
		const width = Math.max(
			1,
			(left ? left.width : 0) + (right ? right.width : 0)
		);
		const pixels = new Uint8ClampedArray(width * height * 4);
		pixels.fill(255);
		const paste = (page: RenderedPage, offsetX: number) => {
			const copyWidth = Math.min(page.width, width - offsetX);
			const copyHeight = Math.min(page.height, height);
			for (let y = 0; y < copyHeight; y++) {
				const srcBase = y * page.width * 4;
				const dstBase = (offsetX + y * width) * 4;
				pixels.set(
					page.pixels.subarray(srcBase, srcBase + copyWidth * 4),
					dstBase
				);
			}
		};
		if (left) {
			paste(left, 0);
		}
		if (right) {
			paste(right, left ? left.width : 0);
		}
		return { width: Math.max(1, width), height, pixels };
	}

	requestRender(): void {
		void this.renderCurrent();
	}
}
