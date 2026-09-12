import { FileView, Notice, setIcon, TFile, WorkspaceLeaf } from 'obsidian';
import type PdfDuhPlugin from './main';
import {
	getMupdfEngine,
	MupdfDocument,
	MupdfEngine,
	PdfPasswordError,
} from './libmupdf';
import type { OutlineItem } from './libmupdf';

export const VIEW_TYPE_PDF_VIEWER = 'mupdf-viewer';

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

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('mupdf-viewer');

		const toolbarEl = contentEl.createDiv('mupdf-viewer-toolbar');

		this.prevButtonEl = toolbarEl.createEl('button', { cls: 'clickable-icon' });
		setIcon(this.prevButtonEl, 'chevron-left');
		this.prevButtonEl.addEventListener('click', () => {
			void this.goToPage(this.pageIndex - 1);
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
		this.pageCountLabelEl.setText('/ -');

		this.nextButtonEl = toolbarEl.createEl('button', { cls: 'clickable-icon' });
		setIcon(this.nextButtonEl, 'chevron-right');
		this.nextButtonEl.addEventListener('click', () => {
			void this.goToPage(this.pageIndex + 1);
		});

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
				void this.goToPage(key === 'n' ? this.pageIndex + 1 : this.pageIndex - 1);
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
			this.engine = await getMupdfEngine(
				(path) => this.app.vault.adapter.readBinary(path),
				this.plugin.mupdfWasmPath()
			);
			const data = await this.app.vault.readBinary(file);
			this.doc = this.engine.openDocument(new Uint8Array(data));
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
			const page = this.doc.renderPage(this.pageIndex, bitmapWidth);
			this.canvasEl.width = page.width;
			this.canvasEl.height = page.height;
			this.canvasEl.style.width = `${displayWidth}px`;
			this.canvasEl.style.height = `${Math.round(
				(displayWidth * page.height) / page.width
			)}px`;
			const ctx = this.canvasEl.getContext('2d');
			if (!ctx) {
				throw new Error('Canvas 2D context unavailable');
			}
			ctx.putImageData(new ImageData(page.pixels, page.width, page.height), 0, 0);
			this.pageInputEl.value = String(this.pageIndex + 1);
			this.pageInputEl.disabled = false;
			this.pageCountLabelEl.setText(`/ ${this.pageCount}`);
			this.prevButtonEl.disabled = this.pageIndex <= 0;
			this.nextButtonEl.disabled = this.pageIndex >= this.pageCount - 1;
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

	requestRender(): void {
		void this.renderCurrent();
	}
}
