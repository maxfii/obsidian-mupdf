import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { PdfListView, VIEW_TYPE_PDF_LIST } from './pdf-list-view';
import { PdfMetadataView, VIEW_TYPE_PDF_METADATA } from './pdf-metadata-view';
import { PdfViewerView, VIEW_TYPE_PDF_VIEWER } from './pdf-viewer-view';

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

		this.registerView(VIEW_TYPE_PDF_METADATA, (leaf) => new PdfMetadataView(leaf, this));

		// Ribbon icon: the button on the left sidebar.
		// The `this.registerDomEvent`-style cleanup applies here too: Obsidian
		// removes the ribbon element for you on unload.
		const ribbonIconEl = this.addRibbonIcon('file-text', 'Open PDF Duh', () => {
			void this.activatePdfListView();
		});
		ribbonIconEl.addClass('pdf-duh-ribbon-class');

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
			id: 'show-pdf-structure',
			name: 'Show PDF structure',
			callback: () => {
				void this.activatePdfMetadataView();
			},
		});

		// Status bar item: text at the bottom-right of the window.
		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText('PDF Duh ready');

		this.takeOverPdfExtension();

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

	/** Reuse an existing PDF structure panel if one is open, otherwise create it. */
	async activatePdfMetadataView(): Promise<void> {
		const { workspace } = this.app;

		const existing = workspace.getLeavesOfType(VIEW_TYPE_PDF_METADATA);
		if (existing.length > 0) {
			workspace.revealLeaf(existing[0]);
			return;
		}

		const leaf = workspace.getRightLeaf(false);
		if (!leaf) {
			new Notice('PDF Duh: failed to open the structure panel');
			return;
		}
		await leaf.setViewState({ type: VIEW_TYPE_PDF_METADATA, active: true });
		workspace.revealLeaf(leaf);
	}

	/** Jump the (first) PDF viewer tab to the given page index. */
	async jumpToPdfPage(pageIndex: number): Promise<void> {
		const { workspace } = this.app;
		const leaf = workspace.getLeavesOfType(VIEW_TYPE_PDF_VIEWER)[0];
		if (!leaf) {
			return;
		}
		const view = leaf.view;
		if (view instanceof PdfViewerView) {
			workspace.revealLeaf(leaf);
			await view.goToPage(pageIndex);
		}
	}

	/** Ask any open PDF structure panels to re-read the active document. */
	refreshPdfMetadataView(): void {
		const { workspace } = this.app;
		for (const leaf of workspace.getLeavesOfType(VIEW_TYPE_PDF_METADATA)) {
			const view = leaf.view;
			if (view instanceof PdfMetadataView) {
				view.refresh();
			}
		}
	}

	/** Move the current-bookmark highlight in any open PDF structure panels. */
	updatePdfMetadataHighlight(pageIndex: number): void {
		const { workspace } = this.app;
		for (const leaf of workspace.getLeavesOfType(VIEW_TYPE_PDF_METADATA)) {
			const view = leaf.view;
			if (view instanceof PdfMetadataView) {
				view.updateHighlight(pageIndex);
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
					typeByExtension: Record<string, unknown>;
					unregisterExtensions?: (extensions: string[]) => void;
				};
			}).viewRegistry;
			const defaultPdfCreator = registry.typeByExtension['pdf'];
			if (defaultPdfCreator === undefined) {
				throw new Error('no default PDF handler registered');
			}
			if (registry.unregisterExtensions) {
				registry.unregisterExtensions(['pdf']);
			} else {
				delete registry.typeByExtension['pdf'];
			}
			this.registerExtensions(['pdf'], VIEW_TYPE_PDF_VIEWER);
			this.register(() => {
				registry.typeByExtension['pdf'] = defaultPdfCreator;
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
