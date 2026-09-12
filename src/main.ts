import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf } from 'obsidian';
import { PdfListView, VIEW_TYPE_PDF_LIST } from './pdf-list-view';
import { PdfViewerView, VIEW_TYPE_PDF_VIEWER } from './pdf-viewer-view';
import { MupdfOutlineView, VIEW_TYPE_OUTLINE } from './outline-view';

/*
 * Remember when writing your own code:
 * - Every interaction with Obsidian goes through the `Plugin` class below.
 * - `onload()` runs when the plugin is enabled, `onunload()` when disabled.
 * - Anything you register here (commands, events, intervals) is cleaned up
 *   automatically by Obsidian when the plugin is disabled.
 */

// Remember to rename these classes and interfaces!
interface PdfDuhSettings {
	mySetting: string;
}

const DEFAULT_SETTINGS: PdfDuhSettings = {
	mySetting: 'default',
};

export default class PdfDuhPlugin extends Plugin {
	settings: PdfDuhSettings;

	async onload() {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_PDF_LIST, (leaf) => new PdfListView(leaf));

		this.registerView(VIEW_TYPE_PDF_VIEWER, (leaf) => new PdfViewerView(leaf, this));

		// Ribbon icon: the button on the left sidebar.
		// The `this.registerDomEvent`-style cleanup applies here too: Obsidian
		// removes the ribbon element for you on unload.
		const ribbonIconEl = this.addRibbonIcon('file-text', 'Open PDF Duh', () => {
			void this.activatePdfListView();
		});
		ribbonIconEl.addClass('mupdf-ribbon-class');

		// Commands appear in the command palette (Ctrl/Cmd+P).
		// `editor` callbacks only fire when a Markdown editor is focused.
		this.addCommand({
			id: 'open-pdf-list',
			name: 'Open PDF list',
			callback: () => {
				void this.activatePdfListView();
			},
		});

		this.addCommand({
			id: 'open-outline',
			name: 'Open outline (PDF bookmarks in the Outline panel)',
			callback: () => {
				void this.activateOutlineView();
			},
		});

		// Status bar item: text at the bottom-right of the window.
		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText('PDF Duh ready');

		this.takeOverPdfExtension();
		this.takeOverOutlineView();

		// Commands appear in the command palette (Ctrl/Cmd+P).
		// `editor` callbacks only fire when a Markdown editor is focused.
		this.addCommand({
			id: 'open-sample-modal-simple',
			name: 'Open sample modal (simple)',
			callback: () => {
				new SampleModal(this.app).open();
			},
		});

		// A command that checks the active view before doing anything.
		this.addCommand({
			id: 'sample-editor-command',
			name: 'Sample editor command',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				console.log(editor.getSelection());
				editor.replaceSelection('Sample Editor Command');
			},
		});

		// Runs when the user switches to a different file/view.
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => {
				console.log('the active leaf changed');
			})
		);

		// DOM events outside Obsidian's own components need manual scoping.
		this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
			console.log('click', evt);
		});

		// Timers are also auto-cleaned when registered here.
		this.registerInterval(
			window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000)
		);

		// Adds a settings tab so the user can configure the plugin.
		this.addSettingTab(new SampleSettingTab(this.app, this));
	}

	onunload() {}

	/** Reuse an existing PDF list tab if one is open, otherwise create it. */
	async activatePdfListView(): Promise<void> {
		const { workspace } = this.app;

		const existing = workspace.getLeavesOfType(VIEW_TYPE_PDF_LIST);
		if (existing.length > 0) {
			workspace.revealLeaf(existing[0]);
			return;
		}

		const leaf = workspace.getLeaf(true);
		await leaf.setViewState({ type: VIEW_TYPE_PDF_LIST, active: true });
		workspace.revealLeaf(leaf);
	}

	/** Reuse an existing Outline tab if one is open, otherwise create it. */
	async activateOutlineView(): Promise<void> {
		const { workspace } = this.app;

		const existing = workspace.getLeavesOfType(VIEW_TYPE_OUTLINE);
		if (existing.length > 0) {
			workspace.revealLeaf(existing[0]);
			return;
		}

		const leaf = workspace.getRightLeaf(false);
		if (!leaf) {
			new Notice('PDF Duh: failed to open the outline panel');
			return;
		}
		await leaf.setViewState({ type: VIEW_TYPE_OUTLINE, active: true });
		workspace.revealLeaf(leaf);
	}

	/**
	 * Serve the core Outline view type with our own view, so the Outline
	 * panel shows PDF bookmark trees when a PDF is active. Mirrors
	 * takeOverPdfExtension: swap the registered view class and restore it
	 * on unload.
	 */
	private takeOverOutlineView(): void {
		try {
			const registry = (this.app as unknown as {
				viewRegistry: {
					viewByType: Record<string, unknown>;
				};
			}).viewRegistry;
			const defaultOutlineCreator = registry.viewByType[VIEW_TYPE_OUTLINE];
			if (defaultOutlineCreator === undefined) {
				// Outline core plugin disabled: just serve the view type.
				this.registerView(
					VIEW_TYPE_OUTLINE,
					(leaf: WorkspaceLeaf) => new MupdfOutlineView(leaf, this)
				);
				return;
			}
			registry.viewByType[VIEW_TYPE_OUTLINE] = (
				leaf: WorkspaceLeaf
			) => new MupdfOutlineView(leaf, this);
			this.register(() => {
				registry.viewByType[VIEW_TYPE_OUTLINE] = defaultOutlineCreator;
			});
			void this.recreateOutlineLeaves();
		} catch (error) {
			console.error('PDF Duh: failed to take over the Outline panel', error);
			new Notice('PDF Duh: could not take over the Outline panel');
		}
	}

	/** Re-create open Outline tabs so they pick up our view class. */
	private async recreateOutlineLeaves(): Promise<void> {
		const { workspace } = this.app;
		for (const leaf of workspace.getLeavesOfType(VIEW_TYPE_OUTLINE)) {
			if (leaf.view instanceof MupdfOutlineView) {
				continue;
			}
			await leaf.setViewState({ type: 'empty' });
			await leaf.setViewState({ type: VIEW_TYPE_OUTLINE });
		}
	}

	/**
	 * Jump a PDF viewer tab to the given page index. Prefers the provided
	 * viewer, otherwise the active one, otherwise the first open viewer tab.
	 */
	async jumpToPdfPage(pageIndex: number, viewer?: PdfViewerView): Promise<void> {
		const { workspace } = this.app;
		const leaf =
			viewer?.leaf ??
			(workspace.getActiveViewOfType(PdfViewerView)?.leaf ??
				workspace.getLeavesOfType(VIEW_TYPE_PDF_VIEWER)[0]);
		if (!leaf) {
			return;
		}
		const view = leaf.view;
		if (view instanceof PdfViewerView) {
			workspace.revealLeaf(leaf);
			await view.goToPage(pageIndex);
		}
	}

	/** Ask any open Outline panels to re-read the active document. */
	refreshPdfStructureViews(): void {
		const { workspace } = this.app;
		for (const leaf of workspace.getLeavesOfType(VIEW_TYPE_OUTLINE)) {
			const view = leaf.view;
			if (view instanceof MupdfOutlineView) {
				view.refresh();
			}
		}
	}

	/** Move the current-bookmark highlight in any open Outline panels. */
	updatePdfPageHighlight(pageIndex: number): void {
		const { workspace } = this.app;
		for (const leaf of workspace.getLeavesOfType(VIEW_TYPE_OUTLINE)) {
			const view = leaf.view;
			if (view instanceof MupdfOutlineView) {
				view.updatePdfHighlight(pageIndex);
			}
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	mupdfWasmPath(): string {
		return `${this.manifest.dir}/mupdf-wasm.wasm`;
	}

	private takeOverPdfExtension(): void {
		try {
			const registry = (this.app as unknown as {
				viewRegistry: {
					viewByType: Record<string, unknown>;
					typeByExtension: Record<string, unknown>;
					registerExtensions: (extensions: string[], type: string) => void;
					unregisterExtensions?: (extensions: string[]) => void;
				};
			}).viewRegistry;

			// The creator for the default "pdf" view. Normally found via
			// typeByExtension, but if a previous disable/unload cycle left the
			// extension mapping dangling (our cleanup deletes it after the
			// restore callback re-added it, LIFO order), it can still be
			// recovered from viewByType, where core registers the view type
			// "pdf" permanently.
			let defaultPdfCreator = registry.typeByExtension['pdf'];
			if (defaultPdfCreator === undefined) {
				defaultPdfCreator = registry.viewByType['pdf'];
			}
			if (defaultPdfCreator === undefined) {
				throw new Error('no default PDF handler registered');
			}

			// Unregister first, then claim the extension. registerExtensions
			// throws if the extension is already taken, so we must not rely on
			// our own registerExtensions cleanup to have run.
			if (registry.unregisterExtensions) {
				registry.unregisterExtensions(['pdf']);
			} else {
				delete registry.typeByExtension['pdf'];
			}
			// Claim via the registry directly instead of
			// this.registerExtensions: the Component-level wrapper would
			// register its own cleanup that unregisters the mapping AFTER our
			// restore callback runs (LIFO), leaving 'pdf' dangling with no
			// handler on the next enable.
			registry.registerExtensions(['pdf'], VIEW_TYPE_PDF_VIEWER);
			this.register(() => {
				registry.unregisterExtensions?.(['pdf']);
				// Hand the extension back to core's built-in "pdf" view type.
				registry.registerExtensions(['pdf'], 'pdf');
			});
		} catch (error) {
			console.error('PDF Duh: failed to take over PDF viewing', error);
			new Notice(
				'PDF Duh: could not take over PDF viewing, PDFs will open with the default viewer'
			);
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

/** A modal: a popup window. */
class SampleModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.setText('Woah!');
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

/** The settings tab, rendered from your plugin settings page. */
class SampleSettingTab extends PluginSettingTab {
	plugin: PdfDuhPlugin;

	constructor(app: App, plugin: PdfDuhPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Setting #1')
			.setDesc("It's a secret")
			.addText((text) =>
				text
					.setPlaceholder('Enter your secret')
					.setValue(this.plugin.settings.mySetting)
					.onChange(async (value) => {
						this.plugin.settings.mySetting = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
