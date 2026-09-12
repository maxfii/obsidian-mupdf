import {
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	WorkspaceLeaf,
} from 'obsidian';
import { getMupdfEngine } from './libmupdf';
import { PdfViewerView, VIEW_TYPE_PDF_VIEWER } from './pdf-viewer-view';
import { MupdfOutlineView, VIEW_TYPE_OUTLINE } from './outline-view';

interface PdfDuhSettings {
	renderScale: number;
}

const DEFAULT_SETTINGS: PdfDuhSettings = {
	renderScale: 1,
};

export default class PdfDuhPlugin extends Plugin {
	settings: PdfDuhSettings = DEFAULT_SETTINGS;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new PdfDuhSettingTab(this.app, this));
		this.registerView(VIEW_TYPE_PDF_VIEWER, (leaf) => new PdfViewerView(leaf, this));

		this.takeOverPdfExtension();
		this.takeOverOutlineView();

		void getMupdfEngine(
			(path) => this.app.vault.adapter.readBinary(path),
			this.mupdfWasmPath()
		).catch((error) => {
			console.error('PDF Duh: failed to preload MuPDF engine', error);
		});
	}

	onunload() {}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** Re-render every open PDF viewer tab at the current settings. */
	refreshPdfViewers(): void {
		const { workspace } = this.app;
		for (const leaf of workspace.getLeavesOfType(VIEW_TYPE_PDF_VIEWER)) {
			const view = leaf.view;
			if (view instanceof PdfViewerView) {
				view.requestRender();
			}
		}
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
}

class PdfDuhSettingTab extends PluginSettingTab {
	constructor(app: PdfDuhPlugin['app'], private plugin: PdfDuhPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Render sharpness')
			.setDesc(
				'Fraction of the pane width to rasterize pages at (0.1–4). ' +
					'Lower values render faster but look blurrier. Applied to open PDF tabs immediately.'
			)
			.addText((text) => {
				text.inputEl.type = 'number';
				text.inputEl.step = '0.05';
				text.inputEl.min = '0.1';
				text.inputEl.max = '4';
				text.setValue(String(this.plugin.settings.renderScale));
				text.onChange(async (value) => {
					const parsed = Number.parseFloat(value);
					if (!Number.isFinite(parsed)) {
						return;
					}
					this.plugin.settings.renderScale = Math.min(
						4,
						Math.max(0.1, parsed)
					);
					await this.plugin.saveSettings();
					this.plugin.refreshPdfViewers();
				});
			});
	}
}
