import {
	ItemView,
	MarkdownView,
	TFile,
	WorkspaceLeaf,
	type HeadingCache,
} from 'obsidian';
import type { MupdfDocument, OutlineItem } from './libmupdf';
import {
	OutlineTreeSpec,
	OutlineTreeWidget,
	outlineTreeSpecs,
} from './outline-tree';
import { PdfViewerView } from './pdf-viewer-view';
import type PdfDuhPlugin from './main';

export const VIEW_TYPE_OUTLINE = 'outline';

/**
 * Replacement for Obsidian's core Outline view. Shows the bookmark tree of
 * the active PDF (with filter, collapse controls and a highlight that follows
 * the current page) and a heading outline when a markdown note is active, so
 * the core plugin's normal behaviour keeps working.
 */
export class MupdfOutlineView extends ItemView {
	private mode: 'pdf' | 'markdown' | 'none' = 'none';
	private currentDoc: MupdfDocument | null = null;
	/** Sticky sources: kept when the Outline itself is focused. */
	private currentViewer: PdfViewerView | null = null;
	private markdownPath: string | null = null;
	private markdownSignature: string | null = null;
	private tree: OutlineTreeWidget | null = null;
	private scrollRaf: number | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: PdfDuhPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_OUTLINE;
	}

	getDisplayText(): string {
		return 'Outline';
	}

	getIcon(): string {
		return 'list';
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass('mupdf-outline-view');
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => {
				this.refresh();
			})
		);
		this.registerEvent(
			this.app.metadataCache.on('changed', (file: TFile) => {
				if (this.mode === 'markdown' && file.path === this.markdownPath) {
					this.refresh();
				}
			})
		);
		this.registerEvent(
			this.app.metadataCache.on('resolved', () => {
				if (this.mode === 'markdown') {
					this.refresh();
				}
			})
		);
		this.registerDomEvent(
			document,
			'scroll',
			(event: Event) => this.onScroll(event),
			{ capture: true }
		);
		this.register(() => {
			if (this.scrollRaf !== null) {
				cancelAnimationFrame(this.scrollRaf);
				this.scrollRaf = null;
			}
		});
		this.refresh();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	refresh(): void {
		const { workspace } = this.app;
		const pdfViewer = workspace.getActiveViewOfType(PdfViewerView);
		const markdownView = workspace.getActiveViewOfType(MarkdownView);
		if (pdfViewer) {
			this.currentViewer = pdfViewer;
			this.markdownPath = null;
			this.markdownSignature = null;
		} else if (markdownView?.file) {
			this.currentViewer = null;
			this.markdownPath = markdownView.file.path;
			this.markdownSignature = null;
		}
		// When neither matches (the Outline itself or another sidebar is
		// focused) keep the previous source, like the core Outline does.

		if (this.currentViewer) {
			if (this.currentViewer.doc) {
				this.renderPdf(this.currentViewer.doc, this.currentViewer.currentPage);
				return;
			}
			// The tracked viewer unloaded its document; drop it.
			this.currentViewer = null;
		}
		const file =
			this.markdownPath !== null
				? this.app.vault.getAbstractFileByPath(this.markdownPath)
				: null;
		if (file instanceof TFile) {
			this.renderMarkdown(file);
			return;
		}
		this.markdownPath = null;
		this.markdownSignature = null;
		if (this.mode !== 'none') {
			this.mode = 'none';
			this.showEmpty('Open a note or PDF to see its outline here.');
		}
	}

	/** Page-change signal from the PDF viewer; ignored outside PDF mode. */
	updatePdfHighlight(pageIndex: number): void {
		if (this.mode === 'pdf') {
			this.tree?.updateHighlight(pageIndex);
		}
	}

	private renderPdf(doc: MupdfDocument, currentPage: number): void {
		if (this.mode === 'pdf' && doc === this.currentDoc) {
			this.tree?.updateHighlight(currentPage);
			return;
		}
		this.mode = 'pdf';
		this.currentDoc = doc;
		this.markdownPath = null;
		this.markdownSignature = null;

		let outline: OutlineItem[] | null = null;
		try {
			outline = doc.loadOutline();
		} catch (error) {
			console.error('PDF Duh: failed to read PDF bookmarks', error);
		}
		if (!outline || outline.length === 0) {
			this.showEmpty('No bookmarks');
			return;
		}
		this.tree = new OutlineTreeWidget(this.contentEl);
		this.tree.render(
			outlineTreeSpecs(outline, (page) => {
				void this.plugin.jumpToPdfPage(page, this.currentViewer ?? undefined);
			})
		);
		this.tree.updateHighlight(currentPage);
	}

	private renderMarkdown(file: TFile): void {
		const headings =
			this.app.metadataCache.getFileCache(file)?.headings ?? [];
		const signature = headings
			.map((h) => `${h.level}:${h.position.start.line}:${h.heading}`)
			.join('\n');
		const sameFile =
			this.mode === 'markdown' && this.markdownPath === file.path;
		if (!sameFile || signature !== this.markdownSignature) {
			this.mode = 'markdown';
			this.currentDoc = null;
			this.markdownPath = file.path;
			this.markdownSignature = signature;
			if (headings.length === 0) {
				this.showEmpty('No headings');
				return;
			}
			this.tree = new OutlineTreeWidget(this.contentEl);
			this.tree.render(this.buildHeadingTree(file, headings));
		}
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view?.file?.path === file.path) {
			this.tree?.updateHighlight(this.markdownTopLine(view));
		} else {
			this.tree?.updateHighlight(null);
		}
	}

	private showEmpty(text: string): void {
		this.tree = null;
		this.contentEl.empty();
		this.contentEl.createDiv({
			text,
			cls: 'mupdf-tree-empty',
		});
	}

	private buildHeadingTree(
		file: TFile,
		headings: HeadingCache[]
	): OutlineTreeSpec[] {
		const root: OutlineTreeSpec[] = [];
		const stack: { level: number; spec: OutlineTreeSpec }[] = [];
		for (const heading of headings) {
			const spec: OutlineTreeSpec = {
				title: heading.heading || '(untitled heading)',
				key: heading.position.start.line,
				open: true,
				onActivate: () => {
					void this.jumpToHeading(file, heading);
				},
				children: [],
			};
			while (stack.length && stack[stack.length - 1].level >= heading.level) {
				stack.pop();
			}
			const parent = stack[stack.length - 1]?.spec;
			if (parent) {
				parent.children.push(spec);
			} else {
				root.push(spec);
			}
			stack.push({ level: heading.level, spec });
		}
		return root;
	}

	private async jumpToHeading(
		file: TFile,
		heading: HeadingCache
	): Promise<void> {
		const { workspace } = this.app;
		let view = workspace.getActiveViewOfType(MarkdownView);
		if (!view || view.file?.path !== file.path) {
			const leaf = workspace.getLeaf(false);
			await leaf.openFile(file);
			view = workspace.getActiveViewOfType(MarkdownView);
		}
		if (!view || view.file?.path !== file.path) {
			return;
		}
		const line = heading.position.start.line;
		view.editor.setCursor({ line, ch: 0 });
		view.editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
		this.tree?.updateHighlight(line);
	}

	/**
	 * The line at the top of the editor viewport, so the highlight follows
	 * scrolling like the core outline. Falls back to the cursor line when
	 * the CodeMirror view cannot be reached.
	 */
	private markdownTopLine(view: MarkdownView): number {
		const cm = (
			view.editor as unknown as {
				cm?: { viewport?: { from?: number } };
			}
		).cm;
		const from = cm?.viewport?.from;
		if (typeof from === 'number') {
			return view.editor.offsetToPos(from).line;
		}
		return view.editor.getCursor().line;
	}

	private onScroll(event: Event): void {
		if (this.mode !== 'markdown' || !(event.target instanceof Node)) {
			return;
		}
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || !view.contentEl.contains(event.target)) {
			return;
		}
		if (this.scrollRaf !== null) {
			return;
		}
		this.scrollRaf = requestAnimationFrame(() => {
			this.scrollRaf = null;
			const active = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (active) {
				this.tree?.updateHighlight(this.markdownTopLine(active));
			}
		});
	}
}
