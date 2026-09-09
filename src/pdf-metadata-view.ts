import { ItemView, setIcon, WorkspaceLeaf } from 'obsidian';
import type { MupdfDocument, OutlineItem } from './libmupdf';
import type PdfDuhPlugin from './main';
import { PdfViewerView, VIEW_TYPE_PDF_VIEWER } from './pdf-viewer-view';

export const VIEW_TYPE_PDF_METADATA = 'pdf-duh-metadata';

interface OutlineEntry {
	/** Lowercased bookmark title, used by the filter. */
	title: string;
	row: HTMLElement;
	item: HTMLElement;
	children: HTMLElement | null;
}

export class PdfMetadataView extends ItemView {
	private currentDoc: MupdfDocument | null = null;
	private outlineRows: { page: number; row: HTMLElement }[] = [];
	private highlightedRows: HTMLElement[] = [];
	private entries: OutlineEntry[] = [];
	private treeEl: HTMLElement | null = null;
	private noMatchesEl: HTMLElement | null = null;

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
		const viewer = this.findViewer();
		const doc = viewer?.doc ?? null;
		if (doc === this.currentDoc) {
			return;
		}
		this.currentDoc = doc;
		this.render(doc);
	}

	private render(doc: MupdfDocument | null): void {
		const { contentEl } = this;
		contentEl.empty();
		this.outlineRows = [];
		this.highlightedRows = [];
		this.entries = [];
		this.treeEl = null;
		this.noMatchesEl = null;

		if (!doc) {
			contentEl.createDiv({
				text: 'Open a PDF to see its structure here.',
				cls: 'pdf-duh-metadata-empty',
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
				cls: 'pdf-duh-metadata-empty',
			});
			return;
		}

		if (!outline || outline.length === 0) {
			contentEl.createDiv({
				text: 'No bookmarks',
				cls: 'pdf-duh-metadata-empty',
			});
			return;
		}

		const controlsEl = contentEl.createDiv('pdf-duh-metadata-controls');
		const actionsEl = controlsEl.createDiv('pdf-duh-metadata-actions');
		const collapseButton = actionsEl.createEl('button', {
			cls: 'clickable-icon',
			attr: { 'aria-label': 'Collapse all except current bookmark' },
		});
		setIcon(collapseButton, 'chevrons-down-up');
		collapseButton.addEventListener('click', () => {
			this.collapseToCurrent();
		});
		const searchEl = controlsEl.createEl('input', {
			type: 'search',
			placeholder: 'Filter bookmarks…',
			cls: 'pdf-duh-metadata-search',
		});
		searchEl.addEventListener('input', () => {
			this.applyFilter(searchEl.value);
		});

		this.noMatchesEl = contentEl.createDiv('pdf-duh-metadata-no-matches');
		this.noMatchesEl.setText('No matching bookmarks');
		this.noMatchesEl.hide();

		const treeEl = contentEl.createDiv('pdf-duh-metadata-tree');
		this.treeEl = treeEl;
		for (const item of outline) {
			this.renderOutlineItem(treeEl, item, 0);
		}
		this.outlineRows.sort((a, b) => a.page - b.page);
		this.updateHighlight(this.findViewer()?.currentPage ?? null);
	}

	/**
	 * Fuzzy-filter the tree without mutating it. Toggles filter classes on
	 * the existing DOM only; clearing the query restores the exact prior
	 * tree state (collapse state, scroll position).
	 */
	private applyFilter(rawQuery: string): void {
		const treeEl = this.treeEl;
		if (!treeEl) {
			return;
		}
		const query = rawQuery.trim().toLowerCase();
		if (!query) {
			treeEl.removeClass('is-filtering');
			for (const entry of this.entries) {
				entry.item.removeClass('is-filter-match');
				entry.children?.removeClass('is-filter-visible');
			}
			this.noMatchesEl?.hide();
			return;
		}

		treeEl.addClass('is-filtering');
		let matchCount = 0;
		for (const entry of this.entries) {
			if (isFuzzyMatch(entry.title, query)) {
				entry.item.addClass('is-filter-match');
				matchCount++;
			} else {
				entry.item.removeClass('is-filter-match');
			}
		}

		for (const entry of this.entries) {
			if (!entry.item.hasClass('is-filter-match')) {
				continue;
			}
			let current: HTMLElement | null = entry.item;
			while (current) {
				const container = current.parentElement;
				if (
					!container ||
					!container.hasClass('pdf-duh-metadata-outline-children')
				) {
					break;
				}
				if (container.hasClass('is-filter-visible')) {
					break;
				}
				container.addClass('is-filter-visible');
				current = this.parentOutlineItem(current);
			}
		}

		if (matchCount === 0) {
			this.noMatchesEl?.show();
		} else {
			this.noMatchesEl?.hide();
		}
	}

	/**
	 * Highlight the closest bookmark page at-or-before the given page and
	 * keep it in view on every page change. All bookmarks that share the
	 * target page are highlighted together. The highlighted rows' ancestor
	 * sections are always expanded (at any depth) and the rows are scrolled
	 * into view.
	 */
	updateHighlight(pageIndex: number | null): void {
		let targetPage: number | null = null;
		if (pageIndex !== null) {
			for (const entry of this.outlineRows) {
				if (entry.page <= pageIndex) {
					targetPage = entry.page;
				} else {
					break;
				}
			}
		}
		const targets: HTMLElement[] = [];
		if (targetPage !== null) {
			for (const entry of this.outlineRows) {
				if (entry.page === targetPage) {
					targets.push(entry.row);
				}
			}
		}
		const changed =
			targets.length !== this.highlightedRows.length ||
			targets.some((row, i) => row !== this.highlightedRows[i]);
		if (changed) {
			for (const row of this.highlightedRows) {
				row.removeClass('is-current');
			}
			for (const row of targets) {
				row.addClass('is-current');
			}
			this.highlightedRows = targets;
		}
		for (const row of targets) {
			this.revealRow(row);
		}
	}

	private revealRow(row: HTMLElement): void {
		this.expandAncestors(row);
		row.scrollIntoView({ block: 'nearest' });
	}

	/**
	 * Collapse every branch except the ancestor path leading to the
	 * is-current bookmark(s), then keep the highlight in view. With no
	 * highlight, collapses everything.
	 */
	private collapseToCurrent(): void {
		if (!this.treeEl) {
			return;
		}
		const keepOpen = new Set<HTMLElement>();
		for (const row of this.highlightedRows) {
			let item = row.closest<HTMLElement>(
				'.pdf-duh-metadata-outline-item'
			);
			while (item) {
				keepOpen.add(item);
				if (item.hasClass('pdf-duh-metadata-collapsible')) {
					item.addClass('is-open');
				}
				item = this.parentOutlineItem(item);
			}
		}
		for (const entry of this.entries) {
			if (
				entry.children &&
				entry.item.hasClass('is-open') &&
				!keepOpen.has(entry.item)
			) {
				entry.item.removeClass('is-open');
			}
		}
		for (const row of this.highlightedRows) {
			this.revealRow(row);
		}
	}

	/**
	 * The outline item that owns the children container the given item sits
	 * in. Children containers are siblings of their owning item, not
	 * descendants, so the parent must be found via previousElementSibling.
	 */
	private parentOutlineItem(item: HTMLElement): HTMLElement | null {
		const container = item.parentElement;
		if (
			!container ||
			!container.hasClass('pdf-duh-metadata-outline-children')
		) {
			return null;
		}
		const prev = container.previousElementSibling;
		return prev instanceof HTMLElement &&
			prev.hasClass('pdf-duh-metadata-outline-item')
			? prev
			: null;
	}

	private expandAncestors(row: HTMLElement): void {
		let item = row.closest<HTMLElement>('.pdf-duh-metadata-outline-item');
		while (item) {
			const parent = this.parentOutlineItem(item);
			if (parent && !parent.hasClass('is-open')) {
				parent.addClass('is-open');
			}
			item = parent;
		}
	}

	private renderOutlineItem(
		containerEl: HTMLElement,
		item: OutlineItem,
		depth: number
	): void {
		const itemEl = containerEl.createDiv('pdf-duh-metadata-outline-item');
		itemEl.style.paddingLeft = `${depth * 16}px`;

		const hasChildren = item.children.length > 0;
		let childrenEl: HTMLElement | null = null;
		if (hasChildren) {
			itemEl.addClass('pdf-duh-metadata-collapsible');
			if (item.open || depth === 0) {
				itemEl.addClass('is-open');
			}
			childrenEl = containerEl.createDiv(
				'pdf-duh-metadata-outline-children'
			);
		}

		const rowEl = itemEl.createDiv('pdf-duh-metadata-outline-row');
		if (hasChildren) {
			const caretEl = rowEl.createSpan('pdf-duh-metadata-caret');
			setIcon(caretEl, 'chevron-right');
		} else {
			rowEl.createSpan('pdf-duh-metadata-caret');
		}

		rowEl.createSpan({
			text: item.title || 'Untitled',
			cls: 'pdf-duh-metadata-outline-title',
		});

		if (item.page !== null) {
			rowEl.createSpan({
				text: `${item.page + 1}`,
				cls: 'pdf-duh-metadata-outline-page',
			});
			this.outlineRows.push({ page: item.page, row: rowEl });
		}

		this.entries.push({
			title: (item.title || '').toLowerCase(),
			row: rowEl,
			item: itemEl,
			children: childrenEl,
		});

		rowEl.addEventListener('click', (event) => {
			if (hasChildren && event.target !== null) {
				const target = event.target as HTMLElement;
				if (target.closest('.pdf-duh-metadata-caret')) {
					toggleOutlineItem(itemEl);
					return;
				}
			}
			if (item.page !== null) {
				void this.plugin.jumpToPdfPage(item.page);
			}
		});

		if (childrenEl && hasChildren) {
			for (const child of item.children) {
				this.renderOutlineItem(childrenEl, child, depth + 1);
			}
		}
	}

	private findViewer(): PdfViewerView | null {
		const { workspace } = this.app;
		const activeView =
			workspace.getActiveViewOfType<PdfViewerView>(PdfViewerView);
		if (activeView?.doc) {
			return activeView;
		}
		for (const leaf of workspace.getLeavesOfType(VIEW_TYPE_PDF_VIEWER)) {
			const view = leaf.view;
			if (view instanceof PdfViewerView && view.doc) {
				return view;
			}
		}
		return null;
	}
}

function toggleOutlineItem(itemEl: HTMLElement): void {
	itemEl.toggleClass('is-open', !itemEl.hasClass('is-open'));
}

/** True when every query char appears in the title in order. */
function isFuzzyMatch(title: string, query: string): boolean {
	let index = 0;
	for (const ch of query) {
		index = title.indexOf(ch, index);
		if (index === -1) {
			return false;
		}
		index++;
	}
	return true;
}
