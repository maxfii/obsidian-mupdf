import { setIcon } from 'obsidian';
import type { OutlineItem } from './libmupdf';

export interface OutlineTreeSpec {
	title: string;
	/** Optional right-aligned label, e.g. the page number. */
	badge?: string;
	/**
	 * Monotonic sort key (PDF page index, markdown heading line) used by the
	 * current-position highlight. Rows without a key never get highlighted.
	 */
	key: number | null;
	/** Initial open state for branches. Root items are always opened. */
	open?: boolean;
	onActivate: () => void;
	children: OutlineTreeSpec[];
}

interface OutlineTreeEntry {
	title: string;
	key: number | null;
	row: HTMLElement;
	item: HTMLElement;
	children: HTMLElement | null;
}

interface KeyedRow {
	key: number;
	row: HTMLElement;
}

/** Map a mupdf outline into generic tree specs. */
export function outlineTreeSpecs(
	items: OutlineItem[],
	jumpToPage: (page: number) => void
): OutlineTreeSpec[] {
	return items.map((item) => ({
		title: item.title || 'Untitled',
		badge: item.page !== null ? `${item.page + 1}` : undefined,
		key: item.page,
		open: item.open,
		onActivate: () => {
			if (item.page !== null) {
				jumpToPage(item.page);
			}
		},
		children: outlineTreeSpecs(item.children, jumpToPage),
	}));
}

/**
 * Collapsible tree with fuzzy filter, collapse/expand controls and a
 * "current" highlight that follows a monotonically increasing key (PDF page
 * index, markdown heading line). Re-rendering with `render()` preserves the
 * active filter query.
 */
export class OutlineTreeWidget {
	private entries: OutlineTreeEntry[] = [];
	private keyedRows: KeyedRow[] = [];
	private highlightedRows: HTMLElement[] = [];
	private treeEl: HTMLElement | null = null;
	private noMatchesEl: HTMLElement | null = null;
	private query = '';

	constructor(private containerEl: HTMLElement) {}

	render(specs: OutlineTreeSpec[]): void {
		const { containerEl } = this;
		containerEl.empty();
		this.entries = [];
		this.keyedRows = [];
		this.highlightedRows = [];
		this.treeEl = null;
		this.noMatchesEl = null;

		const controlsEl = containerEl.createDiv('mupdf-tree-controls');
		const actionsEl = controlsEl.createDiv('mupdf-tree-actions');

		const collapseButton = actionsEl.createEl('button', {
			cls: 'clickable-icon',
			attr: { 'aria-label': 'Collapse all except current bookmark' },
		});
		setIcon(collapseButton, 'chevrons-down-up');
		collapseButton.addEventListener('click', () => {
			this.collapseToCurrent();
		});

		const expandButton = actionsEl.createEl('button', {
			cls: 'clickable-icon',
			attr: { 'aria-label': 'Expand all' },
		});
		setIcon(expandButton, 'chevrons-up-down');
		expandButton.addEventListener('click', () => {
			this.expandAll();
		});

		const searchWrapEl = controlsEl.createDiv('mupdf-tree-search-wrapper');
		const searchEl = searchWrapEl.createEl('input', {
			type: 'search',
			placeholder: 'Filter…',
			cls: 'mupdf-tree-search',
		});
		const clearSearchEl = searchWrapEl.createDiv(
			'mupdf-tree-search-clear clickable-icon'
		);
		setIcon(clearSearchEl, 'x');
		const updateClearButton = (): void => {
			clearSearchEl.toggleClass('is-visible', searchEl.value.length > 0);
		};
		searchEl.addEventListener('input', () => {
			this.query = searchEl.value;
			this.applyFilter(searchEl.value);
			updateClearButton();
		});
		clearSearchEl.addEventListener('click', () => {
			searchEl.value = '';
			this.query = '';
			this.applyFilter('');
			updateClearButton();
			searchEl.focus();
		});

		this.noMatchesEl = containerEl.createDiv('mupdf-tree-no-matches');
		this.noMatchesEl.setText('No matches');
		this.noMatchesEl.hide();

		const treeEl = containerEl.createDiv('mupdf-tree');
		this.treeEl = treeEl;
		for (const spec of specs) {
			this.renderItem(treeEl, spec, 0);
		}
		this.keyedRows.sort((a, b) => a.key - b.key);

		if (this.query) {
			searchEl.value = this.query;
			updateClearButton();
			this.applyFilter(this.query);
		}
	}

	/**
	 * Highlight the closest keyed entry at-or-before the given key and keep
	 * it in view on every update. All entries sharing the target key are
	 * highlighted together. The highlighted rows' ancestor sections are
	 * always expanded (at any depth) and the rows are scrolled into view.
	 */
	updateHighlight(key: number | null): void {
		let targetKey: number | null = null;
		if (key !== null) {
			for (const entry of this.keyedRows) {
				if (entry.key <= key) {
					targetKey = entry.key;
				} else {
					break;
				}
			}
		}
		const targets: HTMLElement[] = [];
		if (targetKey !== null) {
			for (const entry of this.keyedRows) {
				if (entry.key === targetKey) {
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
				if (!container || !container.hasClass('mupdf-tree-children')) {
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

	private revealRow(row: HTMLElement): void {
		this.expandAncestors(row);
		row.scrollIntoView({ block: 'nearest' });
	}

	/**
	 * Collapse every branch except the ancestor path leading to the
	 * is-current row(s), then keep the highlight in view. With no highlight,
	 * collapses everything.
	 */
	private collapseToCurrent(): void {
		if (!this.treeEl) {
			return;
		}
		const keepOpen = new Set<HTMLElement>();
		for (const row of this.highlightedRows) {
			let item = row.closest<HTMLElement>('.mupdf-tree-item');
			while (item) {
				keepOpen.add(item);
				if (item.hasClass('mupdf-tree-collapsible')) {
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

	/** Expand every branch, then keep the highlight in view. */
	private expandAll(): void {
		if (!this.treeEl) {
			return;
		}
		for (const entry of this.entries) {
			if (entry.children) {
				entry.item.addClass('is-open');
			}
		}
		for (const row of this.highlightedRows) {
			this.revealRow(row);
		}
	}

	/**
	 * The tree item that owns the children container the given item sits in.
	 * Children containers are siblings of their owning item, not
	 * descendants, so the parent must be found via previousElementSibling.
	 */
	private parentOutlineItem(item: HTMLElement): HTMLElement | null {
		const container = item.parentElement;
		if (!container || !container.hasClass('mupdf-tree-children')) {
			return null;
		}
		const prev = container.previousElementSibling;
		return prev instanceof HTMLElement && prev.hasClass('mupdf-tree-item')
			? prev
			: null;
	}

	private expandAncestors(row: HTMLElement): void {
		let item = row.closest<HTMLElement>('.mupdf-tree-item');
		while (item) {
			const parent = this.parentOutlineItem(item);
			if (parent && !parent.hasClass('is-open')) {
				parent.addClass('is-open');
			}
			item = parent;
		}
	}

	private renderItem(
		containerEl: HTMLElement,
		spec: OutlineTreeSpec,
		depth: number
	): void {
		const itemEl = containerEl.createDiv('mupdf-tree-item');
		itemEl.style.paddingLeft = `${depth * 16}px`;

		const hasChildren = spec.children.length > 0;
		let childrenEl: HTMLElement | null = null;
		if (hasChildren) {
			itemEl.addClass('mupdf-tree-collapsible');
			if (spec.open || depth === 0) {
				itemEl.addClass('is-open');
			}
			childrenEl = containerEl.createDiv('mupdf-tree-children');
		}

		const rowEl = itemEl.createDiv('mupdf-tree-row');
		const caretEl = rowEl.createSpan('mupdf-tree-caret');
		if (hasChildren) {
			setIcon(caretEl, 'chevron-right');
		}

		rowEl.createSpan({
			text: spec.title,
			cls: 'mupdf-tree-title',
		});

		if (spec.badge !== undefined) {
			rowEl.createSpan({
				text: spec.badge,
				cls: 'mupdf-tree-badge',
			});
		}

		if (spec.key !== null) {
			this.keyedRows.push({ key: spec.key, row: rowEl });
		}
		this.entries.push({
			title: spec.title.toLowerCase(),
			key: spec.key,
			row: rowEl,
			item: itemEl,
			children: childrenEl,
		});

		rowEl.addEventListener('click', (event) => {
			if (event.target !== null) {
				const target = event.target as HTMLElement;
				if (target.closest('.mupdf-tree-caret')) {
					if (hasChildren) {
						toggleOutlineItem(itemEl);
					}
					return;
				}
			}
			spec.onActivate();
		});

		if (childrenEl && hasChildren) {
			for (const child of spec.children) {
				this.renderItem(childrenEl, child, depth + 1);
			}
		}
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
