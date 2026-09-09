import { App, ItemView, Notice, TFile, WorkspaceLeaf } from 'obsidian';
import rectRenderWasm from './wasm/main.c';

export const VIEW_TYPE_PDF_LIST = 'pdf-duh-list';

/** A tab that lists every PDF in the vault. */
export class PdfListView extends ItemView {
	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_PDF_LIST;
	}

	getDisplayText(): string {
		return 'PDFs';
	}

	getIcon(): string {
		return 'file-text';
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('pdf-duh-list-view');

		const canvasEl = contentEl.createEl('canvas', {
			attr: { width: '240', height: '120' },
		});
		canvasEl.addClass('pdf-duh-canvas');
		try {
			await this.renderRedRect(canvasEl);
		} catch (error) {
			console.error('PDF Duh: WASM rect render failed', error);
			new Notice('PDF Duh: failed to render WASM canvas');
		}

		const pdfs = this.getPdfs();

		if (pdfs.length === 0) {
			contentEl.createDiv({
				text: 'No PDFs found in this vault.',
				cls: 'pdf-duh-list-empty',
			});
			return;
		}

		const listEl = contentEl.createDiv('pdf-duh-list');
		for (const file of pdfs) {
			const rowEl = listEl.createDiv('pdf-duh-list-item');
			rowEl.createDiv({ text: file.name, cls: 'pdf-duh-list-item-name' });
			const folder = file.parent?.path ?? '/';
			rowEl.createDiv({
				text: folder === '/' ? '/' : folder,
				cls: 'pdf-duh-list-item-path',
			});
			rowEl.addEventListener('click', () => {
				void this.app.workspace.getLeaf('tab').openFile(file);
			});
		}
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	private async renderRedRect(canvas: HTMLCanvasElement): Promise<void> {
		const { instance } = await WebAssembly.instantiate(rectRenderWasm);
		const exports = instance.exports as {
			rect_render(x: number, y: number, w: number, h: number): void;
			pixels_ptr(): number;
			memory: WebAssembly.Memory;
		};
		exports.rect_render(20, 20, 200, 80);

		const ctx = canvas.getContext('2d');
		if (!ctx) {
			throw new Error('Canvas 2D context unavailable');
		}

		const image = ctx.createImageData(canvas.width, canvas.height);
		image.data.set(
			new Uint8Array(
				exports.memory.buffer,
				exports.pixels_ptr(),
				canvas.width * canvas.height * 4
			)
		);
		ctx.putImageData(image, 0, 0);
	}

	private getPdfs(): TFile[] {
		return this.app.vault
			.getFiles()
			.filter((file) => file.extension === 'pdf')
			.sort((a, b) => a.path.localeCompare(b.path));
	}
}
