import glueFactory from 'mupdf/dist/mupdf-wasm';

type Ptr = number;

interface LibMupdf {
	HEAPU8: Uint8Array;
	HEAPF32: Float32Array;
	UTF8ToString(ptr: Ptr): string;
	stringToUTF8(str: string, outPtr: Ptr, maxBytesToWrite: number): number;
	lengthBytesUTF8(str: string): number;
	_wasm_init_context(): void;
	_wasm_malloc(size: number): Ptr;
	_wasm_free(ptr: Ptr): void;
	_wasm_new_buffer_from_data(data: Ptr, size: number): Ptr;
	_wasm_drop_buffer(buffer: Ptr): void;
	_wasm_open_document_with_buffer(magic: Ptr, buffer: Ptr): Ptr;
	_wasm_needs_password(doc: Ptr): number;
	_wasm_count_pages(doc: Ptr): number;
	_wasm_load_page(doc: Ptr, index: number): Ptr;
	_wasm_drop_page(page: Ptr): void;
	_wasm_drop_document(doc: Ptr): void;
	_wasm_bound_page(page: Ptr, boxType: number): Ptr;
	_wasm_device_rgb(): Ptr;
	_wasm_drop_colorspace(colorspace: Ptr): void;
	_wasm_new_pixmap_with_bbox(colorspace: Ptr, bbox: Ptr, alpha: boolean): Ptr;
	_wasm_clear_pixmap_with_value(pixmap: Ptr, value: number): void;
	_wasm_new_draw_device(ctm: Ptr, pixmap: Ptr): Ptr;
	_wasm_run_page(page: Ptr, device: Ptr, ctm: Ptr): void;
	_wasm_close_device(device: Ptr): void;
	_wasm_drop_device(device: Ptr): void;
	_wasm_pixmap_get_w(pixmap: Ptr): number;
	_wasm_pixmap_get_h(pixmap: Ptr): number;
	_wasm_pixmap_get_n(pixmap: Ptr): number;
	_wasm_pixmap_get_stride(pixmap: Ptr): number;
	_wasm_pixmap_get_samples(pixmap: Ptr): Ptr;
	_wasm_drop_pixmap(pixmap: Ptr): void;
	_wasm_load_outline(doc: Ptr): Ptr;
	_wasm_outline_get_title(outline: Ptr): Ptr;
	_wasm_outline_get_uri(outline: Ptr): Ptr;
	_wasm_outline_get_down(outline: Ptr): Ptr;
	_wasm_outline_get_next(outline: Ptr): Ptr;
	_wasm_outline_get_is_open(outline: Ptr): Ptr;
	_wasm_outline_get_page(doc: Ptr, outline: Ptr): number;
	_wasm_load_links(page: Ptr): Ptr;
	_wasm_link_get_next(link: Ptr): Ptr;
	_wasm_link_get_uri(link: Ptr): Ptr;
	_wasm_pdf_document_from_fz_document(doc: Ptr): Ptr;
	_wasm_pdf_page_from_fz_page(page: Ptr): Ptr;
	_wasm_pdf_first_annot(page: Ptr): Ptr;
	_wasm_pdf_next_annot(annot: Ptr): Ptr;
	_wasm_pdf_annot_type(annot: Ptr): number;
	_wasm_pdf_first_widget(page: Ptr): Ptr;
	_wasm_pdf_next_widget(widget: Ptr): Ptr;
}

interface GlueOptions {
	wasmBinary: Uint8Array;
	instantiateWasm(
		imports: WebAssembly.Imports,
		receiveInstance: (instance: WebAssembly.Instance) => void
	): void;
}

export interface RenderedPage {
	width: number;
	height: number;
	pixels: Uint8ClampedArray;
}

export interface OutlineItem {
	title: string;
	uri: string;
	page: number | null;
	open: boolean;
	children: OutlineItem[];
}

export interface PdfStructure {
	linkCount: number;
	externalLinkCount: number;
	annotationCounts: Record<string, number>;
	widgetCount: number;
}

export const PDF_ANNOTATION_TYPES = [
	'Text',
	'Link',
	'FreeText',
	'Line',
	'Square',
	'Circle',
	'Polygon',
	'PolyLine',
	'Highlight',
	'Underline',
	'Squiggly',
	'StrikeOut',
	'Redact',
	'Stamp',
	'Caret',
	'Ink',
	'Popup',
	'FileAttachment',
	'Sound',
	'Movie',
	'RichMedia',
	'Widget',
	'Screen',
	'PrinterMark',
	'TrapNet',
	'Watermark',
	'3D',
	'Projection',
] as const;

export class PdfPasswordError extends Error {
	constructor() {
		super('PDF is password protected');
		this.name = 'PdfPasswordError';
	}
}

const CROP_BOX = 1;
const MAGIC = 'application/pdf';

let activeLib: LibMupdf | null = null;

function installGlobalHooks(): void {
	const globals = globalThis as Record<string, unknown>;
	if (globals.$libmupdf_load_font_file === undefined) {
		globals.$libmupdf_load_font_file = () => 0;
	}
	if (globals.$libmupdf_log_error === undefined) {
		globals.$libmupdf_log_error = (ptr: Ptr) => {
			const text = activeLib ? activeLib.UTF8ToString(ptr) : String(ptr);
			console.error('MuPDF:', text);
		};
	}
	if (globals.$libmupdf_log_warning === undefined) {
		globals.$libmupdf_log_warning = (ptr: Ptr) => {
			const text = activeLib ? activeLib.UTF8ToString(ptr) : String(ptr);
			console.warn('MuPDF:', text);
		};
	}
}

export class MupdfEngine {
	private rectPtr: Ptr;
	private matrixPtr: Ptr;
	private magicPtr: Ptr;
	lib: LibMupdf;
	rgbPtr: Ptr;

	private constructor(lib: LibMupdf) {
		this.lib = lib;
		this.rectPtr = lib._wasm_malloc(4 * 4);
		this.matrixPtr = lib._wasm_malloc(4 * 6);
		this.magicPtr = this.allocString(MAGIC);
		this.rgbPtr = lib._wasm_device_rgb();
		activeLib = lib;
	}

	static async load(
		readBinary: (path: string) => Promise<ArrayBuffer>,
		wasmPath: string
	): Promise<MupdfEngine> {
		const bytes = new Uint8Array(await readBinary(wasmPath));
		installGlobalHooks();
		const lib = (await glueFactory({
			wasmBinary: bytes,
			instantiateWasm: (
				imports: WebAssembly.Imports,
				receiveInstance: (instance: WebAssembly.Instance) => void
			) => {
				void WebAssembly.instantiate(bytes, imports).then((output) =>
					receiveInstance(output.instance)
				);
			},
		} as GlueOptions)) as unknown as LibMupdf;
		lib._wasm_init_context();
		return new MupdfEngine(lib);
	}

	openDocument(data: Uint8Array): MupdfDocument {
		const lib = this.lib;
		const dataPtr = lib._wasm_malloc(data.byteLength);
		lib.HEAPU8.set(data, dataPtr);
		const bufPtr = lib._wasm_new_buffer_from_data(dataPtr, data.byteLength);
		let docPtr: Ptr = 0;
		try {
			docPtr = lib._wasm_open_document_with_buffer(this.magicPtr, bufPtr);
		} catch (error) {
			lib._wasm_drop_buffer(bufPtr);
			throw error;
		}
		lib._wasm_drop_buffer(bufPtr);
		if (!docPtr) {
			throw new Error('MuPDF failed to open document');
		}
		if (lib._wasm_needs_password(docPtr) !== 0) {
			lib._wasm_drop_document(docPtr);
			throw new PdfPasswordError();
		}
		return new MupdfDocument(this, docPtr);
	}

	private allocString(str: string): Ptr {
		const size = this.lib.lengthBytesUTF8(str) + 1;
		const ptr = this.lib._wasm_malloc(size);
		this.lib.stringToUTF8(str, ptr, size);
		return ptr;
	}

	writeRect(rect: number[]): Ptr {
		const view = this.lib.HEAPF32;
		const base = this.rectPtr >> 2;
		for (let i = 0; i < 4; i++) {
			view[base + i] = rect[i];
		}
		return this.rectPtr;
	}

	writeMatrix(matrix: number[]): Ptr {
		const view = this.lib.HEAPF32;
		const base = this.matrixPtr >> 2;
		for (let i = 0; i < 6; i++) {
			view[base + i] = matrix[i];
		}
		return this.matrixPtr;
	}

	readRect(ptr: Ptr): number[] {
		const view = this.lib.HEAPF32;
		const base = ptr >> 2;
		return [
			view[base],
			view[base + 1],
			view[base + 2],
			view[base + 3],
		];
	}

	readPixmap(pixmapPtr: Ptr): RenderedPage {
		const lib = this.lib;
		const width = lib._wasm_pixmap_get_w(pixmapPtr);
		const height = lib._wasm_pixmap_get_h(pixmapPtr);
		const components = lib._wasm_pixmap_get_n(pixmapPtr);
		const stride = lib._wasm_pixmap_get_stride(pixmapPtr);
		const samplesPtr = lib._wasm_pixmap_get_samples(pixmapPtr);
		const rowBytes = width * components;
		const src = new Uint8Array(
			lib.HEAPU8.buffer,
			samplesPtr,
			stride * height
		);
		if (components === 4) {
			const out = new Uint8ClampedArray(rowBytes * height);
			if (stride === rowBytes) {
				out.set(src);
			} else {
				for (let y = 0; y < height; y++) {
					out.set(
						src.subarray(y * stride, y * stride + rowBytes),
						y * rowBytes
					);
				}
			}
			return { width, height, pixels: out };
		}
		if (components === 3) {
			const out = new Uint8ClampedArray(width * 4 * height);
			for (let y = 0; y < height; y++) {
				let srcBase = y * stride;
				let dstBase = y * width * 4;
				for (let x = 0; x < width; x++) {
					out[dstBase] = src[srcBase];
					out[dstBase + 1] = src[srcBase + 1];
					out[dstBase + 2] = src[srcBase + 2];
					out[dstBase + 3] = 255;
					srcBase += 3;
					dstBase += 4;
				}
			}
			return { width, height, pixels: out };
		}
		throw new Error(
			`MuPDF pixmap has unsupported component count: ${components}`
		);
	}
}

export class MupdfDocument {
	private ptr: Ptr;

	constructor(private engine: MupdfEngine, docPtr: Ptr) {
		this.ptr = docPtr;
	}

	countPages(): number {
		return this.engine.lib._wasm_count_pages(this.ptr);
	}

	loadOutline(): OutlineItem[] | null {
		const lib = this.engine.lib;
		const docPtr = this.ptr;
		const walk = (outlinePtr: Ptr): OutlineItem[] => {
			const items: OutlineItem[] = [];
			while (outlinePtr) {
				const titlePtr = lib._wasm_outline_get_title(outlinePtr);
				const uriPtr = lib._wasm_outline_get_uri(outlinePtr);
				const item: OutlineItem = {
					title: titlePtr ? lib.UTF8ToString(titlePtr) : '',
					uri: uriPtr ? lib.UTF8ToString(uriPtr) : '',
					page: null,
					open: lib._wasm_outline_get_is_open(outlinePtr) !== 0,
					children: [],
				};
				const page = lib._wasm_outline_get_page(docPtr, outlinePtr);
				if (page >= 0) {
					item.page = page;
				}
				const downPtr = lib._wasm_outline_get_down(outlinePtr);
				if (downPtr) {
					item.children = walk(downPtr);
				}
				items.push(item);
				outlinePtr = lib._wasm_outline_get_next(outlinePtr);
			}
			return items;
		};
		const rootPtr = lib._wasm_load_outline(this.ptr);
		if (!rootPtr) {
			return null;
		}
		return walk(rootPtr);
	}

	getStructure(): PdfStructure {
		const lib = this.engine.lib;
		const structure: PdfStructure = {
			linkCount: 0,
			externalLinkCount: 0,
			annotationCounts: {},
			widgetCount: 0,
		};
		const pdfDocPtr = lib._wasm_pdf_document_from_fz_document(this.ptr);
		const pageCount = this.countPages();
		for (let index = 0; index < pageCount; index++) {
			const pagePtr = lib._wasm_load_page(this.ptr, index);
			if (!pagePtr) {
				continue;
			}
			try {
				let linkPtr = lib._wasm_load_links(pagePtr);
				while (linkPtr) {
					const uriPtr = lib._wasm_link_get_uri(linkPtr);
					if (uriPtr && lib.UTF8ToString(uriPtr)) {
						structure.linkCount++;
						structure.externalLinkCount++;
					} else {
						structure.linkCount++;
					}
					linkPtr = lib._wasm_link_get_next(linkPtr);
				}
				if (pdfDocPtr) {
					const pdfPagePtr =
						lib._wasm_pdf_page_from_fz_page(pagePtr);
					if (pdfPagePtr) {
						let annotPtr = lib._wasm_pdf_first_annot(pdfPagePtr);
						while (annotPtr) {
							const type =
								PDF_ANNOTATION_TYPES[
									lib._wasm_pdf_annot_type(annotPtr)
								] ?? 'Unknown';
							structure.annotationCounts[type] =
								(structure.annotationCounts[type] ?? 0) + 1;
							annotPtr = lib._wasm_pdf_next_annot(annotPtr);
						}
						let widgetPtr = lib._wasm_pdf_first_widget(pdfPagePtr);
						while (widgetPtr) {
							structure.widgetCount++;
							widgetPtr = lib._wasm_pdf_next_widget(widgetPtr);
						}
					}
				}
			} finally {
				lib._wasm_drop_page(pagePtr);
			}
		}
		return structure;
	}

	pageBounds(index: number): number[] {
		const lib = this.engine.lib;
		const pagePtr = lib._wasm_load_page(this.ptr, index);
		if (!pagePtr) {
			throw new Error(`MuPDF failed to load page ${index}`);
		}
		try {
			return this.engine.readRect(lib._wasm_bound_page(pagePtr, CROP_BOX));
		} finally {
			lib._wasm_drop_page(pagePtr);
		}
	}

	renderPage(index: number, width: number): RenderedPage {
		const engine = this.engine;
		const lib = engine.lib;
		const pagePtr = lib._wasm_load_page(this.ptr, index);
		if (!pagePtr) {
			throw new Error(`MuPDF failed to load page ${index}`);
		}
		try {
			const bounds = engine.readRect(lib._wasm_bound_page(pagePtr, CROP_BOX));
			const pageWidth = Math.max(1, bounds[2] - bounds[0]);
			const pageHeight = Math.max(1, bounds[3] - bounds[1]);
			const bitmapWidth = Math.max(1, Math.round(width));
			const bitmapHeight = Math.max(
				1,
				Math.round((pageHeight * bitmapWidth) / pageWidth)
			);
			const scale = bitmapWidth / pageWidth;
			const matrix = [
				scale,
				0,
				0,
				scale,
				-bounds[0] * scale,
				-bounds[1] * scale,
			];
			const pixmapPtr = lib._wasm_new_pixmap_with_bbox(
				engine.rgbPtr,
				engine.writeRect([0, 0, bitmapWidth, bitmapHeight]),
				false
			);
			if (!pixmapPtr) {
				throw new Error('MuPDF failed to allocate pixmap');
			}
			try {
				lib._wasm_clear_pixmap_with_value(pixmapPtr, 255);
				const devicePtr = lib._wasm_new_draw_device(
					engine.writeMatrix([1, 0, 0, 1, 0, 0]),
					pixmapPtr
				);
				if (!devicePtr) {
					throw new Error('MuPDF failed to create draw device');
				}
				try {
					lib._wasm_run_page(
						pagePtr,
						devicePtr,
						engine.writeMatrix(matrix)
					);
				} finally {
					lib._wasm_close_device(devicePtr);
					lib._wasm_drop_device(devicePtr);
				}
				return engine.readPixmap(pixmapPtr);
			} finally {
				lib._wasm_drop_pixmap(pixmapPtr);
			}
		} finally {
			lib._wasm_drop_page(pagePtr);
		}
	}

	destroy(): void {
		if (this.ptr) {
			this.engine.lib._wasm_drop_document(this.ptr);
			this.ptr = 0;
		}
	}
}

let enginePromise: Promise<MupdfEngine> | null = null;

export function getMupdfEngine(
	readBinary: (path: string) => Promise<ArrayBuffer>,
	wasmPath: string
): Promise<MupdfEngine> {
	if (!enginePromise) {
		enginePromise = MupdfEngine.load(readBinary, wasmPath).catch((error) => {
			enginePromise = null;
			throw error;
		});
	}
	return enginePromise;
}
