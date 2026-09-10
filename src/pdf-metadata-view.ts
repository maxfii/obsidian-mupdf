import { ItemView, WorkspaceLeaf } from 'obsidian';
import type { MupdfDocument, OutlineItem } from './libmupdf';
import { OutlineTreeWidget, outlineTreeSpecs } from './outline-tree';
import { findPdfViewer } from './pdf-viewer-view';
import type PdfDuhPlugin from './main';

export const VIEW_TYPE_PDF_METADATA = 'pdf-duh-metadata';

export class PdfMetadataView extends ItemView {
	private currentDoc: MupdfDocument | null = null;
	private tree: OutlineTreeWidget | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: PdfDuhPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_PDF_METADATA;
	}

	getDisplayText(): string {
		return 'PDF structure';
	}

	getIcon(): string {
		return 'list-tree';
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass('pdf-duh-metadata-view');
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => {
				this.refresh();
			})
		);
		this.refresh();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	refresh(): void {
		const viewer = findPdfViewer(this.app);
		const doc = viewer?.doc ?? null;
		if (doc === this.currentDoc) {
			return;
		}
		this.currentDoc = doc;
		this.render(doc, viewer?.currentPage ?? null);
	}

	updateHighlight(pageIndex: number): void {
		this.tree?.updateHighlight(pageIndex);
	}

	private render(doc: MupdfDocument | null, currentPage: number | null): void {
		const { contentEl } = this;
		contentEl.empty();
		this.tree = null;

		if (!doc) {
			contentEl.createDiv({
				text: 'Open a PDF to see its structure here.',
				cls: 'pdf-duh-tree-empty',
			});
			return;
		}

		let outline: OutlineItem[] | null = null;
		try {
			outline = doc.loadOutline();
		} catch (error) {
			console.error('PDF Duh: failed to read PDF bookmarks', error);
			contentEl.createDiv({
				text: 'Failed to read PDF bookmarks.',
				cls: 'pdf-duh-tree-empty',
			});
			return;
		}

		if (!outline || outline.length === 0) {
			contentEl.createDiv({
				text: 'No bookmarks',
				cls: 'pdf-duh-tree-empty',
			});
			return;
		}

		this.tree = new OutlineTreeWidget(contentEl);
		this.tree.render(
			outlineTreeSpecs(outline, (page) => {
				void this.plugin.jumpToPdfPage(page);
			})
		);
		this.tree.updateHighlight(currentPage);
	}
}
